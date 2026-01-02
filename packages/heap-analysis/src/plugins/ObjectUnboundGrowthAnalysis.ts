/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {
  BaseOption,
  IHeapNode,
  IHeapSnapshot,
  IMemoryAnalystOptions,
} from '@memlab/core';
import type {AnalyzeSnapshotResult, HeapAnalysisOptions} from '../PluginUtils';

import fs from 'fs';
import {
  config,
  info,
  memoryBarChart,
  serializer,
  utils,
  TraceFinder,
} from '@memlab/core';
import BaseAnalysis from '../BaseAnalysis';
import SnapshotDirectoryOption from '../options/HeapAnalysisSnapshotDirectoryOption';
import pluginUtils from '../PluginUtils';

class ObjectUnboundGrowthAnalysis extends BaseAnalysis {
  getCommandName(): string {
    return 'unbound-object';
  }

  /** @internal */
  getDescription(): string {
    return (
      'Check unbound object growth ' +
      '(a single object with growing retained size)'
    );
  }

  /** @internal */
  getOptions(): BaseOption[] {
    return [new SnapshotDirectoryOption()];
  }

  /** @internal */
  public async analyzeSnapshotFromFile(
    file: string,
  ): Promise<AnalyzeSnapshotResult> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const f = file;
    throw utils.haltOrThrow(
      `${this.constructor.name} does not support analyzeSnapshotFromFile`,
    );
  }

  /** @internal */
  async process(options: HeapAnalysisOptions): Promise<void> {
    const snapshotDir = pluginUtils.getSnapshotDirForAnalysis(options);
    const opt = snapshotDir ? {minSnapshots: 2, snapshotDir} : {};
    config.chaseWeakMapEdge = false;
    await this.checkUnbound(opt);
  }

  private async checkUnbound(options: IMemoryAnalystOptions = {}) {
    memoryBarChart.plotMemoryBarChart(options);
    utils.checkSnapshots(options);
    await this.detectUnboundGrowth(options);
  }

  // find any objects that keeps growing
  private async detectUnboundGrowth(options: IMemoryAnalystOptions = {}) {
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
    fs.writeFileSync(config.unboundObjectCSV, csv, {encoding: 'utf8'});
  }

  private calculateRetainedSizes(snapshot: IHeapSnapshot): void {
    const finder = new TraceFinder();
    // dominator and retained size
    finder.calculateAllNodesRetainedSizes(snapshot);
  }
}

export default ObjectUnboundGrowthAnalysis;
