/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {HeapAnalysisOptions} from '../PluginUtils';

import {utils, BaseOption} from '@memlab/core';
import SnapshotFileOption from '../options/HeapAnalysisSnapshotFileOption';
import BaseAnalysis from '../BaseAnalysis';
import pluginUtils from '../PluginUtils';

export default class UnmountedFiberNodeAnalysis extends BaseAnalysis {
  getCommandName(): string {
    return 'unmounted-fiber-node';
  }

  /** @internal */
  getDescription(): string {
    return 'Get unmounted React Fiber nodes';
  }

  /** @internal */
  getOptions(): BaseOption[] {
    return [new SnapshotFileOption()];
  }

  /** @internal */
  public async analyzeSnapshotsInDirectory(directory: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const d = directory;
    throw utils.haltOrThrow(
      `${this.constructor.name} does not support analyzeSnapshotsInDirectory`,
    );
  }

  /** @internal */
  async process(options: HeapAnalysisOptions): Promise<void> {
    const snapshot = await pluginUtils.loadHeapSnapshot(options);
    const largeObjects = pluginUtils.filterOutLargestObjects(
      snapshot,
      utils.isDetachedFiberNode,
    );
    pluginUtils.printNodeListInTerminal(largeObjects);
  }
}
