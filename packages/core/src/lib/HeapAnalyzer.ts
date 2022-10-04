/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

'use strict';

import type {
  E2EStepInfo,
  HeapNodeIdSet,
  IHeapEdge,
  IHeapNode,
  IHeapSnapshot,
  IMemoryAnalystHeapNodeLeakSummary,
  IMemoryAnalystHeapNodeReferrenceStat,
  IMemoryAnalystOptions,
  IMemoryAnalystSnapshotDiff,
  IOveralHeapInfo,
  LeakTracePathItem,
  Nullable,
  Optional,
  IOveralLeakInfo,
  TraceCluster,
  ISerializedInfo,
} from './Types';

import fs from 'fs';
import babar from 'babar';
import chalk from 'chalk';
import clusterLogger from '../logger/LeakClusterLogger';
import traceDetailsLogger from '../logger/LeakTraceDetailsLogger';
import TraceFinder from '../paths/TraceFinder';
import NormalizedTrace from '../trace-cluster/TraceBucket';
import config from './Config';
import info from './Console';
import serializer from './Serializer';
import utils from './Utils';
import {LeakObjectFilter} from './leak-filters/LeakObjectFilter';
import MLTraceSimilarityStrategy from '../trace-cluster/strategies/MLTraceSimilarityStrategy';

class MemoryAnalyst {
  async checkLeak(): Promise<ISerializedInfo[]> {
    this.visualizeMemoryUsage();
    utils.checkSnapshots();
    return await this.detectMemoryLeaks();
  }

  async checkUnbound(options: IMemoryAnalystOptions = {}) {
    this.visualizeMemoryUsage(options);
    utils.checkSnapshots(options);
    await this.detectUnboundGrowth(options);
  }

  async breakDownMemoryByShapes(options: {file?: string} = {}) {
    const opt = {buildNodeIdIndex: true, verbose: true};
    const file =
      options.file ||
      utils.getSnapshotFilePathWithTabType(/.*/) ||
      '<EMPTY_FILE_PATH>';
    const snapshot = await utils.getSnapshotFromFile(file, opt);
    this.preparePathFinder(snapshot);
    const heapInfo = this.getOverallHeapInfo(snapshot, {force: true});
    if (heapInfo) {
      this.printHeapInfo(heapInfo);
    }
    this.breakDownSnapshotByShapes(snapshot);
  }

  // find any objects that keeps growing
  async detectUnboundGrowth(options: IMemoryAnalystOptions = {}) {
    const nodeInfo = Object.create(null);
    let hasCheckedFirstSnapshot = false;
    let snapshot: IHeapSnapshot | null = null;

    const isValidNode = (node: IHeapNode) =>
      node.type === 'object' ||
      node.type === 'closure' ||
      node.type === 'regexp';

    const initNodeInfo = (node: IHeapNode) => {
      if (!isValidNode(node)) {
        return;
      }
      const n = node.retainedSize;
      nodeInfo[node.id] = {
        type: node.type,
        name: node.name,
        min: n,
        max: n,
        history: [n],
        node,
      };
    };

    const updateNodeInfo = (node: IHeapNode) => {
      const item = nodeInfo[node.id];
      if (!item) {
        return;
      }
      if (node.name !== item.name || node.type !== item.type) {
        nodeInfo[node.id] = null;
        return;
      }
      const n = node.retainedSize;
      // only monotonic increase?
      if (config.monotonicUnboundGrowthOnly && n < item.max) {
        nodeInfo[node.id] = null;
        return;
      }
      item.history.push(n);
      item.max = Math.max(item.max, n);
      item.min = Math.min(item.min, n);
    };

    // summarize the heap objects info in current heap snapshot
    // this is mainly used for better understanding of the % of
    // objects released and allocated over time
    const maybeSummarizeNodeInfo = () => {
      if (!config.verbose) {
        return;
      }
      let n = 0;
      for (const k in nodeInfo) {
        if (nodeInfo[k]) {
          ++n;
        }
      }
      info.lowLevel(`Objects tracked: ${n}`);
    };

    info.overwrite('Checking unbounded objects...');
    const snapshotFiles = options.snapshotDir
      ? // load snapshots from a directory
        utils.getSnapshotFilesInDir(options.snapshotDir)
      : // load snapshots based on the visit sequence meta data
        utils.getSnapshotFilesFromTabsOrder();

    for (const file of snapshotFiles) {
      // force GC before loading each snapshot
      if (global.gc) {
        global.gc();
      }

      // load and preprocess heap snapshot
      const opt = {buildNodeIdIndex: true, verbose: true};
      snapshot = await utils.getSnapshotFromFile(file, opt);
      this.calculateRetainedSizes(snapshot);

      // keep track of heap objects
      if (!hasCheckedFirstSnapshot) {
        // record Ids in the snapshot
        snapshot.nodes.forEach(initNodeInfo);
        hasCheckedFirstSnapshot = true;
      } else {
        snapshot.nodes.forEach(updateNodeInfo);
        maybeSummarizeNodeInfo();
      }
    }

    // exit if no heap snapshot found
    if (!hasCheckedFirstSnapshot) {
      return;
    }

    // post process and print the unbounded objects
    const idsInLastSnapshot = new Set();
    snapshot?.nodes.forEach(node => {
      idsInLastSnapshot.add(node.id);
    });

    let ids = [];
    for (const key in nodeInfo) {
      const id = parseInt(key, 10);
      const item = nodeInfo[id];
      if (!item) {
        continue;
      }
      if (!idsInLastSnapshot.has(id)) {
        continue;
      }
      if (item.min === item.max) {
        continue;
      }
      // filter out non-significant leaks
      if (item.history[item.history.length - 1] < config.unboundSizeThreshold) {
        continue;
      }
      ids.push({id, ...item});
    }
    if (ids.length === 0) {
      info.midLevel('No increasing objects found.');
      return;
    }
    ids = ids
      .sort(
        (o1, o2) =>
          o2.history[o2.history.length - 1] - o1.history[o1.history.length - 1],
      )
      .slice(0, 20);

    // print on terminal
    const str = serializer.summarizeUnboundedObjects(ids, {color: true});
    info.topLevel('Top growing objects in sizes:');
    info.lowLevel(' (Use `memlab trace --node-id=@ID` to get trace)');
    info.topLevel('\n' + str);
    // save results to file
    const csv = serializer.summarizeUnboundedObjectsToCSV(ids);
    fs.writeFileSync(config.unboundObjectCSV, csv, 'UTF-8');
  }

  // find all unique pattern of leaks
  async detectMemoryLeaks(): Promise<ISerializedInfo[]> {
    const snapshotDiff = await this.diffSnapshots(true);
    config.dumpNodeInfo = false;
    const {paths} = await this.searchLeakedTraces(
      snapshotDiff.leakedHeapNodeIdSet,
      snapshotDiff.snapshot,
    );
    return traceDetailsLogger.logTraces(
      snapshotDiff.leakedHeapNodeIdSet,
      snapshotDiff.snapshot,
      snapshotDiff.listOfLeakedHeapNodeIdSet,
      paths,
      config.traceJsonOutDir,
    );
  }

  visualizeMemoryUsage(options: IMemoryAnalystOptions = {}) {
    if (config.useExternalSnapshot || options.snapshotDir) {
      return;
    }
    const tabsOrder = utils.loadTabsOrder();
    // if memory usage data is incomplete, skip the visualization
    for (const tab of tabsOrder) {
      if (!(tab.JSHeapUsedSize > 0)) {
        if (config.verbose) {
          info.error('Memory usage data incomplete');
        }
        return;
      }
    }
    const plotData = tabsOrder.map((tab, idx) => [
      idx + 1,
      ((tab.JSHeapUsedSize / 100000) | 0) / 10,
    ]);

    // the graph component cannot handle an array with a single element
    while (plotData.length < 2) {
      plotData.push([plotData.length + 1, 0]);
    }

    // plot visual settings
    const minY = 1;
    const maxY = plotData.reduce((m, v) => Math.max(m, v[1]), 0) * 1.15;
    const yFractions = 1;
    const yLabelWidth =
      1 +
      Math.max(
        minY.toFixed(yFractions).length,
        maxY.toFixed(yFractions).length,
      );
    const maxWidth = process.stdout.columns - 10;
    const idealWidth = Math.max(2 * plotData.length + 2 * yLabelWidth, 10);
    const plotWidth = Math.min(idealWidth, maxWidth);

    info.topLevel('Memory usage across all steps:');
    info.topLevel(
      babar(plotData, {
        color: 'green',
        width: plotWidth,
        height: 10,
        xFractions: 0,
        yFractions,
        minY,
        maxY,
      }),
    );
    info.topLevel('');
  }

  async focus(options: {file?: string} = {}) {
    info.overwrite(`Generating report for node @${config.focusFiberNodeId}`);
    let snapshotLeakedHeapNodeIdSet: HeapNodeIdSet = new Set();
    let nodeIdsInSnapshots: Array<HeapNodeIdSet> = [];
    let snapshot: IHeapSnapshot;

    // if specified a heap file
    if (options.file) {
      const opt = {buildNodeIdIndex: true, verbose: true};
      snapshot = await utils.getSnapshotFromFile(options.file, opt);

      // if running in interactive heap analysis mode
    } else if (
      config.heapConfig &&
      config.heapConfig.isCliInteractiveMode &&
      config.heapConfig.currentHeap
    ) {
      snapshot = config.heapConfig.currentHeap;

      // otherwise diff heap snapshots
    } else {
      utils.checkSnapshots();
      const snapshotDiff = await this.diffSnapshots(true);
      nodeIdsInSnapshots = snapshotDiff.listOfLeakedHeapNodeIdSet;
      snapshotLeakedHeapNodeIdSet = snapshotDiff.leakedHeapNodeIdSet;
      snapshot = snapshotDiff.snapshot;
    }

    this.dumpPathByNodeId(
      snapshotLeakedHeapNodeIdSet,
      snapshot,
      nodeIdsInSnapshots,
      config.focusFiberNodeId,
      config.viewJsonFile,
      config.singleReportSummary,
    );
  }

  shouldLoadCompleteSnapshot(
    tabsOrder: E2EStepInfo[],
    tab: E2EStepInfo,
  ): boolean {
    for (let i = tabsOrder.length - 1; i >= 0; --i) {
      const curTab = tabsOrder[i];
      if (curTab.type === 'target' || curTab.type === 'final') {
        return curTab === tab;
      }
    }
    return false;
  }

  async diffSnapshots(loadAll = false): Promise<IMemoryAnalystSnapshotDiff> {
    const nodeIdsInSnapshots = [];
    const tabsOrder = utils.loadTabsOrder();
    // a set keeping track of node ids generated before the target snapshot
    const baselineIds = new Set();
    let collectBaselineIds = true;

    let targetAllocatedHeapNodeIdSet: Nullable<HeapNodeIdSet> = null;
    let leakedHeapNodeIdSet: Nullable<HeapNodeIdSet> = null;
    const options = {verbose: true};
    let snapshot: Nullable<IHeapSnapshot> = null;
    for (let i = 0; i < tabsOrder.length; i++) {
      const tab = tabsOrder[i];

      // force GC before loading each snapshot
      if (global.gc) {
        global.gc();
      }

      // when we see the target snapshot, stop collecting node ids allocated so far
      if (tab.type === 'target') {
        collectBaselineIds = false;
      }

      let idsInSnapshot: HeapNodeIdSet = new Set();
      nodeIdsInSnapshots.push(idsInSnapshot);
      if (!tab.snapshot) {
        continue;
      }
      // in quick mode, there is no need to load all snapshots
      if (!loadAll && !tab.type) {
        continue;
      }

      const file = utils.getSnapshotFilePath(tab);
      if (this.shouldLoadCompleteSnapshot(tabsOrder, tab)) {
        // final snapshot needs to build node index
        const opt = {buildNodeIdIndex: true, ...options};
        snapshot = await utils.getSnapshotFromFile(file, opt);
        // record Ids in the snapshot
        snapshot.nodes.forEach(node => {
          idsInSnapshot.add(node.id);
        });
      } else {
        idsInSnapshot = await utils.getSnapshotNodeIdsFromFile(file, options);
        nodeIdsInSnapshots.pop();
        nodeIdsInSnapshots.push(idsInSnapshot);
      }

      // collect all node ids allocated before the target snapshot
      if (collectBaselineIds) {
        for (const id of idsInSnapshot) {
          baselineIds.add(id);
        }
      }

      if (tab.type === 'target') {
        targetAllocatedHeapNodeIdSet = new Set();
        idsInSnapshot.forEach(id => {
          if (!baselineIds.has(id)) {
            targetAllocatedHeapNodeIdSet?.add(id);
          }
        });

        // if final snapshot is not present,
        // search leaks among `Set { target } \ Set { baseline }`
        leakedHeapNodeIdSet = targetAllocatedHeapNodeIdSet;
      }

      if (tab.type === 'final') {
        if (!targetAllocatedHeapNodeIdSet) {
          utils.haltOrThrow('no target snapshot before finals snapshot');
        }
        leakedHeapNodeIdSet = new Set();
        snapshot?.nodes.forEach(node => {
          if (targetAllocatedHeapNodeIdSet?.has(node.id)) {
            leakedHeapNodeIdSet?.add(node.id);
          }
        });
        targetAllocatedHeapNodeIdSet = null;
      }
    }
    if (!snapshot || !leakedHeapNodeIdSet) {
      throw utils.haltOrThrow('Snapshot incomplete', {
        printErrorBeforeHalting: true,
      });
    }
    return {
      leakedHeapNodeIdSet: leakedHeapNodeIdSet,
      snapshot,
      listOfLeakedHeapNodeIdSet: nodeIdsInSnapshots,
    };
  }

  private calculateRetainedSizes(snapshot: IHeapSnapshot): void {
    const finder = new TraceFinder();
    // dominator and retained size
    finder.calculateAllNodesRetainedSizes(snapshot);
  }

  // initialize the path finder
  preparePathFinder(snapshot: IHeapSnapshot): TraceFinder {
    const finder = new TraceFinder();
    if (!snapshot.isProcessed) {
      // shortest path for all nodes
      finder.annotateShortestPaths(snapshot);
      // dominator and retained size
      finder.calculateAllNodesRetainedSizes(snapshot);
      // mark detached Fiber nodes
      utils.markAllDetachedFiberNode(snapshot);
      // mark alternate Fiber nodes
      utils.markAlternateFiberNode(snapshot);
      snapshot.isProcessed = true;
    }
    return finder;
  }
  // summarize the page interaction and dump to the leak text summary file
  private dumpPageInteractionSummary() {
    const tabsOrder = utils.loadTabsOrder();
    const tabsOrderStr = serializer.summarizeTabsOrder(tabsOrder);
    fs.writeFileSync(config.exploreResultFile, tabsOrderStr, 'UTF-8');
  }

  // summarize the leak and print the info in console
  private dumpLeakSummaryToConsole(
    leakedNodeIds: HeapNodeIdSet,
    snapshot: IHeapSnapshot,
  ) {
    if (!config.verbose && !config.useExternalSnapshot) {
      return;
    }

    info.overwrite('summarizing snapshot diff...');

    const aggregatedLeakSummaryDict: Record<
      string,
      IMemoryAnalystHeapNodeLeakSummary
    > = Object.create(null);

    // count the distribution of nodes
    utils.applyToNodes(leakedNodeIds, snapshot, node => {
      if (!utils.isDebuggableNode(node)) {
        return false;
      }
      const key = `${node.name} (${node.type})`;
      const leakSummary = (aggregatedLeakSummaryDict[key] =
        aggregatedLeakSummaryDict[key] || {
          name: node.name,
          type: node.type,
          count: 0,
          retainedSize: 0,
        });
      leakSummary.count++;
      leakSummary.retainedSize += node.retainedSize | 0;
    });

    const list = Object.entries(aggregatedLeakSummaryDict)
      .sort((e1, e2) => e2[1].retainedSize - e1[1].retainedSize)
      .slice(0, 20)
      .map(entry => {
        const ret = Object.assign(entry[1]);
        ret.retainedSize = utils.getReadableBytes(ret.retainedSize);
        return ret;
      });

    info.topLevel('Alive objects allocated in target page:');
    info.table(list);
  }

  private filterLeakedObjects(
    leakedNodeIds: HeapNodeIdSet,
    snapshot: IHeapSnapshot,
  ) {
    // call init leak filter hook if exists
    if (config.externalLeakFilter?.beforeLeakFilter) {
      config.externalLeakFilter.beforeLeakFilter(snapshot, leakedNodeIds);
    }

    const leakFilter = new LeakObjectFilter();
    // start filtering memory leaks
    utils.filterNodesInPlace(leakedNodeIds, snapshot, node =>
      leakFilter.filter(config, node, snapshot, leakedNodeIds),
    );
    if (config.verbose) {
      info.midLevel(`${leakedNodeIds.size} Fiber nodes and Detached elements`);
    }
  }

  aggregateDominatorMetrics(
    ids: HeapNodeIdSet,
    snapshot: IHeapSnapshot,
    checkNodeCb: (node: IHeapNode) => boolean,
    nodeMetricsCb: (node: IHeapNode) => number,
  ) {
    let ret = 0;
    const dominators = utils.getConditionalDominatorIds(
      ids,
      snapshot,
      checkNodeCb,
    );
    utils.applyToNodes(dominators, snapshot, node => {
      ret += nodeMetricsCb(node);
    });
    return ret;
  }

  private getOverallHeapInfo(
    snapshot: IHeapSnapshot,
    options: {force?: boolean} = {},
  ): Optional<IOveralHeapInfo> {
    if (!config.verbose && !options.force) {
      return;
    }
    info.overwrite('summarizing heap info...');
    const allIds = utils.getNodesIdSet(snapshot);
    const heapInfo = {
      fiberNodeSize: this.aggregateDominatorMetrics(
        allIds,
        snapshot,
        utils.isFiberNode,
        this.getRetainedSize,
      ),
      regularFiberNodeSize: this.aggregateDominatorMetrics(
        allIds,
        snapshot,
        utils.isRegularFiberNode,
        this.getRetainedSize,
      ),
      detachedFiberNodeSize: this.aggregateDominatorMetrics(
        allIds,
        snapshot,
        utils.isDetachedFiberNode,
        this.getRetainedSize,
      ),
      alternateFiberNodeSize: this.aggregateDominatorMetrics(
        allIds,
        snapshot,
        utils.isAlternateNode,
        this.getRetainedSize,
      ),
      error: this.aggregateDominatorMetrics(
        allIds,
        snapshot,
        node => node.name === 'Error',
        this.getRetainedSize,
      ),
    };
    return heapInfo;
  }

  getRetainedSize(node: IHeapNode) {
    return node.retainedSize;
  }

  getOverallLeakInfo(
    leakedNodeIds: HeapNodeIdSet,
    snapshot: IHeapSnapshot,
  ): Optional<IOveralLeakInfo> {
    if (!config.verbose) {
      return;
    }
    const leakInfo = {
      ...this.getOverallHeapInfo(snapshot),
      leakedSize: this.aggregateDominatorMetrics(
        leakedNodeIds,
        snapshot,
        () => true,
        this.getRetainedSize,
      ),
      leakedFiberNodeSize: this.aggregateDominatorMetrics(
        leakedNodeIds,
        snapshot,
        utils.isFiberNode,
        this.getRetainedSize,
      ),
      leakedAlternateFiberNodeSize: this.aggregateDominatorMetrics(
        leakedNodeIds,
        snapshot,
        utils.isAlternateNode,
        this.getRetainedSize,
      ),
    };
    return leakInfo;
  }

  private printHeapInfo(leakInfo: IOveralHeapInfo): void {
    Object.entries(leakInfo)
      .map(([k, v]) => [
        utils.camelCaseToReadableString(k),
        utils.getReadableBytes(v),
      ])
      .forEach(([name, value]) => {
        info.topLevel(`· ${name}: ${value}`);
      });
  }

  private breakDownSnapshotByShapes(snapshot: IHeapSnapshot): void {
    info.overwrite('Breaking down memory by shapes...');
    const breakdown: Record<string, HeapNodeIdSet> = Object.create(null);
    const population: Record<string, {examples: IHeapNode[]; n: number}> =
      Object.create(null);

    // group objects based on their shapes
    snapshot.nodes.forEach(node => {
      if (
        (node.type !== 'object' && !utils.isStringNode(node)) ||
        config.nodeIgnoreSetInShape.has(node.name)
      ) {
        return;
      }
      const key = serializer.summarizeNodeShape(node);
      breakdown[key] = breakdown[key] || new Set();
      breakdown[key].add(node.id);
      if (population[key] === undefined) {
        population[key] = {examples: [], n: 0};
      }
      ++population[key].n;
      // retain the top 5 examples
      const examples = population[key].examples;
      examples.push(node);
      examples.sort((n1, n2) => n2.retainedSize - n1.retainedSize);
      if (examples.length > 5) {
        examples.pop();
      }
    });

    // calculate and sort based on retained sizes
    const ret: Array<{key: string; retainedSize: number}> = [];
    for (const key in breakdown) {
      const size = this.aggregateDominatorMetrics(
        breakdown[key],
        snapshot,
        () => true,
        this.getRetainedSize,
      );
      ret.push({key, retainedSize: size});
    }
    ret.sort((o1, o2) => o2.retainedSize - o1.retainedSize);

    info.topLevel('Object shapes with top retained sizes:');
    info.lowLevel(' (Use `memlab trace --node-id=@ID` to get trace)\n');
    const topList = ret.slice(0, 40);
    // print settings
    const opt = {color: true, compact: true};
    const dot = chalk.grey('· ');
    const colon = chalk.grey(': ');
    // print the shapes with the biggest retained size
    for (const o of topList) {
      const referrerInfo = this.breakDownByReferrers(
        breakdown[o.key],
        snapshot,
      );
      const {examples, n} = population[o.key];
      const shapeStr = serializer.summarizeNodeShape(examples[0], opt);
      const bytes = utils.getReadableBytes(o.retainedSize);
      const examplesStr = examples
        .map(e => `@${e.id} [${utils.getReadableBytes(e.retainedSize)}]`)
        .join(' | ');
      const meta = chalk.grey(` (N: ${n}, Examples: ${examplesStr})`);
      info.topLevel(`${dot}${shapeStr}${colon}${bytes}${meta}`);
      info.lowLevel(referrerInfo + '\n');
    }
  }

  private isTrivialEdgeForBreakDown(edge: IHeapEdge) {
    const source = edge.fromNode;
    return (
      source.type === 'array' ||
      source.name === '(object elements)' ||
      source.name === 'system' ||
      edge.name_or_index === '__proto__' ||
      edge.name_or_index === 'prototype'
    );
  }

  private breakDownByReferrers(
    ids: Set<IHeapNode['id']>,
    snapshot: IHeapSnapshot,
  ): string {
    const edgeNames: Record<string, IMemoryAnalystHeapNodeReferrenceStat> =
      Object.create(null);
    for (const id of ids) {
      const node = snapshot.getNodeById(id);
      for (const edge of node?.referrers || []) {
        const source = edge.fromNode;
        if (
          !utils.isMeaningfulEdge(edge) ||
          this.isTrivialEdgeForBreakDown(edge)
        ) {
          continue;
        }
        const sourceName = serializer.summarizeNodeName(source, {
          color: false,
        });
        const edgeName = serializer.summarizeEdgeName(edge, {
          color: false,
          abstract: true,
        });
        const edgeKey = `[${sourceName}] --${edgeName}--> `;
        edgeNames[edgeKey] = edgeNames[edgeKey] || {
          numberOfEdgesToNode: 0,
          source,
          edge,
        };
        ++edgeNames[edgeKey].numberOfEdgesToNode;
      }
    }
    const referrerInfo = Object.entries(edgeNames)
      .sort((i1, i2) => i2[1].numberOfEdgesToNode - i1[1].numberOfEdgesToNode)
      .slice(0, 4)
      .map(i => {
        const meta = i[1];
        const source = serializer.summarizeNodeName(meta.source, {
          color: true,
        });
        const edgeName = serializer.summarizeEdgeName(meta.edge, {
          color: true,
          abstract: true,
        });
        const edgeSummary = `${source} --${edgeName}-->`;
        return `  · ${edgeSummary}: ${meta.numberOfEdgesToNode}`;
      })
      .join('\n');
    return referrerInfo;
  }

  private printHeapAndLeakInfo(
    leakedNodeIds: HeapNodeIdSet,
    snapshot: IHeapSnapshot,
  ) {
    // write page interaction summary to the leaks text file
    this.dumpPageInteractionSummary();

    // dump leak summry to console
    this.dumpLeakSummaryToConsole(leakedNodeIds, snapshot);

    // get aggregated leak info
    const heapInfo = this.getOverallHeapInfo(snapshot);
    if (heapInfo) {
      this.printHeapInfo(heapInfo);
    }
  }

  private logLeakTraceSummary(
    trace: LeakTracePathItem,
    nodeIdInPaths: HeapNodeIdSet,
    snapshot: IHeapSnapshot,
  ) {
    if (!config.isFullRun) {
      return;
    }
    // convert the path to a string
    const pathStr = serializer.summarizePath(trace, nodeIdInPaths, snapshot);
    fs.appendFileSync(config.exploreResultFile, `\n\n${pathStr}\n\n`, 'UTF-8');
  }

  // find unique paths of leaked nodes
  async searchLeakedTraces(
    leakedNodeIds: HeapNodeIdSet,
    snapshot: IHeapSnapshot,
  ) {
    const finder = this.preparePathFinder(snapshot);

    this.printHeapAndLeakInfo(leakedNodeIds, snapshot);

    // get all leaked objects
    this.filterLeakedObjects(leakedNodeIds, snapshot);

    if (config.verbose) {
      // show a breakdown of different object structures
      this.breakDownSnapshotByShapes(snapshot);
    }

    const nodeIdInPaths: HeapNodeIdSet = new Set();
    const paths: LeakTracePathItem[] = [];
    let numOfLeakedObjects = 0;
    let i = 0;

    // analysis for each node
    utils.applyToNodes(
      leakedNodeIds,
      snapshot,
      node => {
        if (!config.isContinuousTest && ++i % 11 === 0) {
          info.overwrite(`progress: ${i} / ${leakedNodeIds.size} @${node.id}`);
        }
        // BFS search for path from the leaked node to GC roots
        const p = finder.getPathToGCRoots(snapshot, node);
        if (!p || !utils.isInterestingPath(p)) {
          return;
        }

        ++numOfLeakedObjects;
        paths.push(p);

        this.logLeakTraceSummary(p, nodeIdInPaths, snapshot);
      },
      {reverse: true},
    );

    if (config.verbose) {
      info.midLevel(`${numOfLeakedObjects} leaked objects`);
    }

    // cluster traces from the current run
    const clusters = NormalizedTrace.clusterPaths(
      paths,
      snapshot,
      this.aggregateDominatorMetrics,
      {
        strategy: config.isMLClustering
          ? new MLTraceSimilarityStrategy()
          : undefined,
      },
    );
    info.midLevel(`MemLab found ${clusters.length} leak(s)`);
    await this.serializeClusterUpdate(clusters);

    if (config.logUnclassifiedClusters) {
      // cluster traces from the current run
      const clustersUnclassified = NormalizedTrace.generateUnClassifiedClusters(
        paths,
        snapshot,
        this.aggregateDominatorMetrics,
      );
      clusterLogger.logUnclassifiedClusters(clustersUnclassified);
    }

    return {
      paths: clusters.map(c => c.path),
    };
  }

  /**
   * Given a set of heap object ids, cluster them based on the similarity
   * of their retainer traces and return a
   * @param leakedNodeIds
   * @param snapshot
   * @returns
   */
  clusterHeapObjects(
    objectIds: HeapNodeIdSet,
    snapshot: IHeapSnapshot,
  ): TraceCluster[] {
    const finder = this.preparePathFinder(snapshot);

    const paths: LeakTracePathItem[] = [];
    let i = 0;

    // analysis for each node
    utils.applyToNodes(
      objectIds,
      snapshot,
      node => {
        if (++i % 11 === 0) {
          info.overwrite(`progress: ${i} / ${objectIds.size} @${node.id}`);
        }
        // BFS search for path from the leaked node to GC roots
        const p = finder.getPathToGCRoots(snapshot, node);
        if (p) {
          paths.push(p);
        }
      },
      {reverse: true},
    );

    // cluster traces from the current run
    const clusters = NormalizedTrace.clusterPaths(
      paths,
      snapshot,
      this.aggregateDominatorMetrics,
      {
        strategy: config.isMLClustering
          ? new MLTraceSimilarityStrategy()
          : undefined,
      },
    );
    return clusters;
  }

  async serializeClusterUpdate(
    clusters: TraceCluster[],
    options: {reclusterOnly?: boolean} = {},
  ) {
    // load existing clusters
    const existingClusters = await clusterLogger.loadClusters(
      config.currentUniqueClusterDir,
    );
    // figure out stale and new clusters
    const clusterDiff = NormalizedTrace.diffClusters(
      clusters,
      existingClusters,
    );

    if (options.reclusterOnly) {
      // only recluster updates
      clusterLogger.logClusterDiff(clusterDiff);
    } else {
      // log clusters traces for the current run
      clusterLogger.logClusters(clusters, {clusterDiff});
    }
  }

  dumpPathByNodeId(
    leakedIdSet: HeapNodeIdSet,
    snapshot: IHeapSnapshot,
    nodeIdsInSnapshots: Array<HeapNodeIdSet>,
    id: number,
    pathLoaderFile: string,
    summaryFile: string,
  ) {
    info.overwrite('start analysis...');
    const finder = this.preparePathFinder(snapshot);

    const nodeIdInPaths: HeapNodeIdSet = new Set();
    const idSet = new Set([id]);
    traceDetailsLogger.setTraceFileEmpty(pathLoaderFile);
    fs.writeFileSync(summaryFile, 'no path found', 'UTF-8');
    utils.applyToNodes(idSet, snapshot, node => {
      const path = finder.getPathToGCRoots(snapshot, node);
      if (!path) {
        info.topLevel(`path for node @${id} is not found`);
        return;
      }
      traceDetailsLogger.logTrace(
        leakedIdSet,
        snapshot,
        nodeIdsInSnapshots,
        path,
        pathLoaderFile,
      );
      const tabsOrder = utils.loadTabsOrder();
      const interactionSummary = serializer.summarizeTabsOrder(tabsOrder);
      let pathSummary = serializer.summarizePath(
        path,
        nodeIdInPaths,
        snapshot,
        {color: true},
      );
      info.topLevel(pathSummary);
      pathSummary = serializer.summarizePath(path, nodeIdInPaths, snapshot);
      const summary =
        `Page Interaction: \n${interactionSummary}\n\n` +
        `Path from GC Root to Leaked Object:\n${pathSummary}`;
      fs.writeFileSync(summaryFile, summary, 'UTF-8');
    });
  }
}

export default new MemoryAnalyst();
