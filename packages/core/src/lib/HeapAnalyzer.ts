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
  IHeapSnapshot,
  IMemoryAnalystSnapshotDiff,
  IMemoryAnalystHeapNodeLeakSummary,
  IOveralHeapInfo,
  LeakTracePathItem,
  Nullable,
  Optional,
  IOveralLeakInfo,
  TraceCluster,
  ISerializedInfo,
  DiffLeakOptions,
} from './Types';

import fs from 'fs';
import config from './Config';
import info from './Console';
import serializer from './Serializer';
import utils from './Utils';
import fileManager from './FileManager';
import memoryBarChart from './charts/MemoryBarChart';
import clusterLogger from '../logger/LeakClusterLogger';
import traceDetailsLogger from '../logger/LeakTraceDetailsLogger';
import TraceFinder from '../paths/TraceFinder';
import NormalizedTrace from '../trace-cluster/TraceBucket';
import {LeakObjectFilter} from './leak-filters/LeakObjectFilter';
import MLTraceSimilarityStrategy from '../trace-cluster/strategies/MLTraceSimilarityStrategy';
import {LeakTraceFilter} from './trace-filters/LeakTraceFilter';
import TraceSampler from './TraceSampler';

type DiffSnapshotsOptions = {
  loadAllSnapshots?: boolean;
  workDir?: string;
};

type WorkDirOptions = {
  workDir?: string;
};

type GetTraceOptions = {
  workDir?: string;
  printConsoleOnly?: boolean;
};

class MemoryAnalyst {
  async checkLeak(): Promise<ISerializedInfo[]> {
    memoryBarChart.plotMemoryBarChart();
    utils.checkSnapshots();
    return await this.detectMemoryLeaks();
  }

  async diffLeakByWorkDir(
    options: DiffLeakOptions,
  ): Promise<ISerializedInfo[]> {
    const controlSnapshotDirs = options.controlWorkDirs.map(controlWorkDir =>
      fileManager.getCurDataDir({
        workDir: controlWorkDir,
      }),
    );
    const treatmentSnapshotDirs = options.treatmentWorkDirs.map(
      treatmentWorkDir =>
        fileManager.getCurDataDir({
          workDir: treatmentWorkDir,
        }),
    );
    // check control working dir
    controlSnapshotDirs.forEach(controlSnapshotDir =>
      utils.checkSnapshots({snapshotDir: controlSnapshotDir}),
    );
    // check treatment working dir
    treatmentSnapshotDirs.forEach(treatmentSnapshotDir =>
      utils.checkSnapshots({snapshotDir: treatmentSnapshotDir}),
    );
    // display control and treatment memory
    memoryBarChart.plotMemoryBarChart(options);
    return this.diffMemoryLeakTraces(options);
  }

  // find all unique pattern of leaks
  async diffMemoryLeakTraces(
    options: DiffLeakOptions,
  ): Promise<ISerializedInfo[]> {
    config.dumpNodeInfo = false;
    // diff snapshots from control dirs and get control raw paths array
    const controlSnapshots = [];
    const leakPathsFromControlRuns = [];
    for (const controlWorkDir of options.controlWorkDirs) {
      const snapshotDiff = await this.diffSnapshots({
        loadAllSnapshots: true,
        workDir: controlWorkDir,
      });
      leakPathsFromControlRuns.push(
        this.filterLeakPaths(
          snapshotDiff.leakedHeapNodeIdSet,
          snapshotDiff.snapshot,
          {workDir: controlWorkDir},
        ),
      );
      controlSnapshots.push(snapshotDiff.snapshot);
    }
    // diff snapshots from treatment dirs and get treatment raw paths array
    const treatmentSnapshots = [];
    const leakPathsFromTreatmentRuns = [];
    let firstTreatmentSnapshotDiff: Nullable<IMemoryAnalystSnapshotDiff> = null;
    for (const treatmentWorkDir of options.treatmentWorkDirs) {
      const snapshotDiff = await this.diffSnapshots({
        loadAllSnapshots: true,
        workDir: treatmentWorkDir,
      });
      if (firstTreatmentSnapshotDiff == null) {
        firstTreatmentSnapshotDiff = snapshotDiff;
      }
      leakPathsFromTreatmentRuns.push(
        this.filterLeakPaths(
          snapshotDiff.leakedHeapNodeIdSet,
          snapshotDiff.snapshot,
          {workDir: treatmentWorkDir},
        ),
      );
      treatmentSnapshots.push(snapshotDiff.snapshot);
    }
    const controlPathCounts = JSON.stringify(
      leakPathsFromControlRuns.map(leakPaths => leakPaths.length),
    );
    const treatmentPathCounts = JSON.stringify(
      leakPathsFromTreatmentRuns.map(leakPaths => leakPaths.length),
    );
    info.topLevel(`${controlPathCounts} traces from control group`);
    info.topLevel(`${treatmentPathCounts} traces from treatment group`);

    const result = NormalizedTrace.clusterControlTreatmentPaths(
      leakPathsFromControlRuns,
      controlSnapshots,
      leakPathsFromTreatmentRuns,
      treatmentSnapshots,
      utils.aggregateDominatorMetrics,
      {
        strategy: config.isMLClustering
          ? new MLTraceSimilarityStrategy()
          : undefined,
      },
    );
    info.midLevel(
      `MemLab found ${result.treatmentOnlyClusters.length} new leak(s) in the treatment group`,
    );
    await this.serializeClusterUpdate(result.treatmentOnlyClusters);

    // serialize JSON file with detailed leak trace information
    const treatmentOnlyPaths = result.treatmentOnlyClusters.map(c => c.path);
    if (firstTreatmentSnapshotDiff == null) {
      throw utils.haltOrThrow('treatemnt snapshot diff result not found');
    }
    return traceDetailsLogger.logTraces(
      firstTreatmentSnapshotDiff.leakedHeapNodeIdSet,
      firstTreatmentSnapshotDiff.snapshot,
      firstTreatmentSnapshotDiff.listOfLeakedHeapNodeIdSet,
      treatmentOnlyPaths,
      config.traceJsonOutDir,
    );
  }

  // find all unique pattern of leaks
  async detectMemoryLeaks(): Promise<ISerializedInfo[]> {
    const snapshotDiff = await this.diffSnapshots({loadAllSnapshots: true});
    config.dumpNodeInfo = false;
    const paths = await this.findLeakTraces(
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
      const snapshotDiff = await this.diffSnapshots({loadAllSnapshots: true});
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
      {printConsoleOnly: true},
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

  async diffSnapshots(
    options: DiffSnapshotsOptions = {},
  ): Promise<IMemoryAnalystSnapshotDiff> {
    const nodeIdsInSnapshots = [];
    const tabsOrder = utils.loadTabsOrder(
      fileManager.getSnapshotSequenceMetaFile(options),
    );
    // a set keeping track of node ids generated before the target snapshot
    const baselineIds = new Set();
    let collectBaselineIds = true;

    let targetAllocatedHeapNodeIdSet: Nullable<HeapNodeIdSet> = null;
    let leakedHeapNodeIdSet: Nullable<HeapNodeIdSet> = null;
    const parseSnapshotOptions = {verbose: true, workDir: options.workDir};
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
      if (!options.loadAllSnapshots && !tab.type) {
        continue;
      }

      const file = utils.getSnapshotFilePath(tab, options);
      if (this.shouldLoadCompleteSnapshot(tabsOrder, tab)) {
        // final snapshot needs to build node index
        const opt = {
          buildNodeIdIndex: true,
          ...parseSnapshotOptions,
          workDir: options.workDir,
        };
        snapshot = await utils.getSnapshotFromFile(file, opt);
        // record Ids in the snapshot
        snapshot.nodes.forEach(node => {
          idsInSnapshot.add(node.id);
        });
      } else {
        idsInSnapshot = await utils.getSnapshotNodeIdsFromFile(
          file,
          parseSnapshotOptions,
        );
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
  private dumpPageInteractionSummary(options: WorkDirOptions = {}) {
    const tabsOrder = utils.loadTabsOrder(
      fileManager.getSnapshotSequenceMetaFile(options),
    );
    const tabsOrderStr = serializer.summarizeTabsOrder(tabsOrder);
    fs.writeFileSync(
      fileManager.getLeakSummaryFile(options),
      tabsOrderStr,
      'UTF-8',
    );
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

  public getOverallHeapInfo(
    snapshot: IHeapSnapshot,
    options: {force?: boolean} = {},
  ): Optional<IOveralHeapInfo> {
    if (!config.verbose && !options.force) {
      return;
    }
    info.overwrite('summarizing heap info...');
    const allIds = utils.getNodesIdSet(snapshot);
    const heapInfo = {
      fiberNodeSize: utils.aggregateDominatorMetrics(
        allIds,
        snapshot,
        utils.isFiberNode,
        utils.getRetainedSize,
      ),
      regularFiberNodeSize: utils.aggregateDominatorMetrics(
        allIds,
        snapshot,
        utils.isRegularFiberNode,
        utils.getRetainedSize,
      ),
      detachedFiberNodeSize: utils.aggregateDominatorMetrics(
        allIds,
        snapshot,
        utils.isDetachedFiberNode,
        utils.getRetainedSize,
      ),
      alternateFiberNodeSize: utils.aggregateDominatorMetrics(
        allIds,
        snapshot,
        utils.isAlternateNode,
        utils.getRetainedSize,
      ),
      error: utils.aggregateDominatorMetrics(
        allIds,
        snapshot,
        node => node.name === 'Error',
        utils.getRetainedSize,
      ),
    };
    return heapInfo;
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
      leakedSize: utils.aggregateDominatorMetrics(
        leakedNodeIds,
        snapshot,
        () => true,
        utils.getRetainedSize,
      ),
      leakedFiberNodeSize: utils.aggregateDominatorMetrics(
        leakedNodeIds,
        snapshot,
        utils.isFiberNode,
        utils.getRetainedSize,
      ),
      leakedAlternateFiberNodeSize: utils.aggregateDominatorMetrics(
        leakedNodeIds,
        snapshot,
        utils.isAlternateNode,
        utils.getRetainedSize,
      ),
    };
    return leakInfo;
  }

  public printHeapInfo(leakInfo: IOveralHeapInfo): void {
    Object.entries(leakInfo)
      .map(([k, v]) => [
        utils.camelCaseToReadableString(k),
        utils.getReadableBytes(v),
      ])
      .forEach(([name, value]) => {
        info.topLevel(`· ${name}: ${value}`);
      });
  }

  private printHeapAndLeakInfo(
    leakedNodeIds: HeapNodeIdSet,
    snapshot: IHeapSnapshot,
    options: WorkDirOptions = {},
  ) {
    // write page interaction summary to the leaks text file
    this.dumpPageInteractionSummary(options);

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
    options: WorkDirOptions = {},
  ) {
    if (!config.isFullRun) {
      return;
    }
    // convert the path to a string
    const pathStr = serializer.summarizePath(trace, nodeIdInPaths, snapshot);
    fs.appendFileSync(
      fileManager.getLeakSummaryFile(options),
      `\n\n${pathStr}\n\n`,
      'UTF-8',
    );
  }

  filterLeakPaths(
    leakedNodeIds: HeapNodeIdSet,
    snapshot: IHeapSnapshot,
    options: WorkDirOptions = {},
  ): LeakTracePathItem[] {
    const finder = this.preparePathFinder(snapshot);

    this.printHeapAndLeakInfo(leakedNodeIds, snapshot, options);

    // get all leaked objects
    this.filterLeakedObjects(leakedNodeIds, snapshot);

    const leakTraceFilter = new LeakTraceFilter();
    const nodeIdInPaths: HeapNodeIdSet = new Set();
    const samplePool: LeakTracePathItem[] = [];

    // analysis for each node
    utils.applyToNodes(
      leakedNodeIds,
      snapshot,
      node => {
        // BFS search for path from the leaked node to GC roots
        const p = finder.getPathToGCRoots(snapshot, node);
        if (
          p == null ||
          !leakTraceFilter.filter(p, {config, leakedNodeIds, snapshot})
        ) {
          return;
        }
        // filter leak trace based on CLI-specified node or edge names
        if (!utils.pathHasNodeOrEdgeWithName(p, config.filterTraceByName)) {
          return;
        }

        // ignore if the leak trace is too long
        if (utils.getLeakTracePathLength(p) > 100) {
          return;
        }
        samplePool.push(p);
      },
      {reverse: true},
    );

    const sampler = new TraceSampler(samplePool.length);
    const paths = samplePool.filter(p => {
      if (sampler.sample()) {
        this.logLeakTraceSummary(p, nodeIdInPaths, snapshot, options);
        return true;
      }
      return false;
    });

    if (config.verbose) {
      info.midLevel(`Filter and select ${paths.length} leaked trace`);
    }
    return paths;
  }

  // find unique paths of leaked nodes
  async findLeakTraces(
    leakedNodeIds: HeapNodeIdSet,
    snapshot: IHeapSnapshot,
    options: WorkDirOptions = {},
  ): Promise<LeakTracePathItem[]> {
    const paths = this.filterLeakPaths(leakedNodeIds, snapshot, options);
    // cluster traces from the current run
    const clusters = NormalizedTrace.clusterPaths(
      paths,
      snapshot,
      utils.aggregateDominatorMetrics,
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
        utils.aggregateDominatorMetrics,
      );
      clusterLogger.logUnclassifiedClusters(clustersUnclassified);
    }

    return clusters.map(c => c.path);
  }

  /**
   * Given a set of heap object ids, cluster them based on the similarity
   * of their retainer traces
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
    const sampler = new TraceSampler(objectIds.size);

    // analysis for each node
    utils.applyToNodes(
      objectIds,
      snapshot,
      node => {
        if (!sampler.sample()) {
          return;
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
      utils.aggregateDominatorMetrics,
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
    options: GetTraceOptions = {},
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
      let pathSummary = serializer.summarizePath(
        path,
        nodeIdInPaths,
        snapshot,
        {color: true},
      );
      info.topLevel(pathSummary);
      if (options.printConsoleOnly) {
        return;
      }
      const tabsOrder = utils.loadTabsOrder(
        fileManager.getSnapshotSequenceMetaFile(options),
      );
      const interactionSummary = serializer.summarizeTabsOrder(tabsOrder);
      pathSummary = serializer.summarizePath(path, nodeIdInPaths, snapshot);
      const summary =
        `Page Interaction: \n${interactionSummary}\n\n` +
        `Path from GC Root to Leaked Object:\n${pathSummary}`;
      fs.writeFileSync(summaryFile, summary, 'UTF-8');
    });
  }
}

export default new MemoryAnalyst();
