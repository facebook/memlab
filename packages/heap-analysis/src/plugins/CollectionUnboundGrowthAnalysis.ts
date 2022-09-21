/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import type {HeapAnalysisOptions} from '../PluginUtils';
import type {
  BaseOption,
  IHeapNode,
  IHeapSnapshot,
  IMemoryAnalystOptions,
} from '@memlab/core';

import fs from 'fs';
import {analysis, config, utils, info, serializer} from '@memlab/core';
import BaseAnalysis from '../BaseAnalysis';
import SnapshotDirectoryOption from '../options/HeapAnalysisSnapshotDirectoryOption';
import pluginUtils from '../PluginUtils';
import {PluginUtils} from '..';

class CollectionUnboundGrowthAnalysis extends BaseAnalysis {
  getCommandName(): string {
    return 'unbound-collection';
  }

  /** @internal */
  getDescription(): string {
    return (
      'Check unbound collection growth ' +
      '(e.g., Map with growing number of entries)'
    );
  }

  /** @internal */
  getOptions(): BaseOption[] {
    return [new SnapshotDirectoryOption()];
  }

  /** @internal */
  public async analyzeSnapshotFromFile(file: string): Promise<void> {
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
    analysis.visualizeMemoryUsage(opt);
    utils.checkSnapshots(opt);
    await this.checkUnboundCollection(opt);
  }

  private async checkUnboundCollection(
    options: IMemoryAnalystOptions,
  ): Promise<void> {
    const nodeInfo = Object.create(null);
    let hasCheckedFirstSnapshot = false;
    let snapshot: IHeapSnapshot | null = null;

    const initNodeInfo = (node: IHeapNode) => {
      if (!PluginUtils.isCollectObject(node)) {
        return;
      }
      const n = PluginUtils.getCollectionFanout(node);
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
      const n = PluginUtils.getCollectionFanout(node);
      // only monotonic increase?
      if (config.monotonicUnboundGrowthOnly && n < item.max) {
        nodeInfo[node.id] = null;
        return;
      }
      item.history.push(n);
      item.max = Math.max(item.max, n);
      item.min = Math.min(item.min, n);
    };

    info.overwrite('Checking unbounded collections...');
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
      PluginUtils.calculateRetainedSizes(snapshot);

      // keep track of heap objects
      if (!hasCheckedFirstSnapshot) {
        // record Ids in the snapshot
        snapshot.nodes.forEach(initNodeInfo);
        hasCheckedFirstSnapshot = true;
      } else {
        snapshot.nodes.forEach(updateNodeInfo);
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
      ids.push({id, ...item});
    }
    if (ids.length === 0) {
      info.midLevel('No increasing collections found.');
      return;
    }
    ids = ids
      .sort(
        (o1, o2) =>
          o2.history[o2.history.length - 1] - o1.history[o1.history.length - 1],
      )
      .slice(0, 20);

    const formatter = (n: number) => `${n}`;
    ids.forEach(item => (item.historyNumberFormatter = formatter));

    // print on terminal
    const str = serializer.summarizeUnboundedObjects(ids, {color: true});
    info.topLevel('Top growing objects in sizes:');
    info.lowLevel(' (Use `memlab trace --node-id=@ID` to get trace)');
    info.topLevel('\n' + str);
    // save results to file
    const csv = serializer.summarizeUnboundedObjectsToCSV(ids);
    fs.writeFileSync(config.unboundObjectCSV, csv, 'UTF-8');
  }
}

export default CollectionUnboundGrowthAnalysis;
