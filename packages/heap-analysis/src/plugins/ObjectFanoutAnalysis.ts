/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {HeapAnalysisOptions} from '../PluginUtils';
import type {IHeapSnapshot, IHeapNode} from '@memlab/core';

import {ParsedArgs} from 'minimist';
import {BaseOption} from '@memlab/core';
import BaseAnalysis from '../BaseAnalysis';
import pluginUtils from '../PluginUtils';
import SnapshotFileOption from '../options/HeapAnalysisSnapshotFileOption';

class ObjectFanoutAnalysis extends BaseAnalysis {
  getCommandName(): string {
    return 'object-fanout';
  }

  getDescription(): string {
    return 'Get objects with the most out-going references in heap';
  }

  getOptions(): BaseOption[] {
    return [new SnapshotFileOption()];
  }

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
