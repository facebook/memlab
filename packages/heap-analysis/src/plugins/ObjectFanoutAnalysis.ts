/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {AnalyzeSnapshotResult, HeapAnalysisOptions} from '../PluginUtils';
import type {IHeapSnapshot, IHeapNode} from '@memlab/core';

import {ParsedArgs} from 'minimist';
import {BaseOption, utils} from '@memlab/core';
import BaseAnalysis from '../BaseAnalysis';
import pluginUtils from '../PluginUtils';
import SnapshotFileOption from '../options/HeapAnalysisSnapshotFileOption';

class ObjectFanoutAnalysis extends BaseAnalysis {
  getCommandName(): string {
    return 'object-fanout';
  }

  /** @internal */
  getDescription(): string {
    return 'Get objects with the most out-going references in heap';
  }

  /** @internal */
  getOptions(): BaseOption[] {
    return [new SnapshotFileOption()];
  }

  /** @internal */
  public async analyzeSnapshotsInDirectory(
    directory: string,
  ): Promise<AnalyzeSnapshotResult> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const d = directory;
    throw utils.haltOrThrow(
      `${this.constructor.name} does not support analyzeSnapshotsInDirectory`,
    );
  }

  /** @internal */
  async process(options: HeapAnalysisOptions): Promise<void> {
    const snapshot = await pluginUtils.loadHeapSnapshot(options);
    const list = this.getObjectsWithHighFanout(snapshot, options.args);
    pluginUtils.printNodeListInTerminal(list);
  }

  private getObjectsWithHighFanout(
    snapshot: IHeapSnapshot,
    args: ParsedArgs,
  ): IHeapNode[] {
    // rank heap objects based on fanout
    let ret: IHeapNode[] = [];
    const listSize = args.listSize || 20;
    snapshot.nodes.forEach(node => {
      if (!pluginUtils.isNodeWorthInspecting(node)) {
        return;
      }
      const count = pluginUtils.getObjectOutgoingEdgeCount(node);
      let i;
      for (i = ret.length - 1; i >= 0; --i) {
        const curCnt = pluginUtils.getObjectOutgoingEdgeCount(ret[i]);
        if (curCnt >= count) {
          ret.splice(i + 1, 0, node);
          break;
        }
      }
      if (i < 0) {
        ret.unshift(node);
      }
      ret = ret.slice(0, listSize);
    });
    return ret;
  }
}

export default ObjectFanoutAnalysis;
