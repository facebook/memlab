/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {AnalyzeSnapshotResult, HeapAnalysisOptions} from '../PluginUtils';

import {BaseOption, utils} from '@memlab/core';
import BaseAnalysis from '../BaseAnalysis';
import pluginUtils from '../PluginUtils';
import SnapshotFileOption from '../options/HeapAnalysisSnapshotFileOption';
import OutputOption from '../options/HeapAnalysisOutputOption';

class ObjectSizeRankAnalysis extends BaseAnalysis {
  getCommandName(): string {
    return 'object-size';
  }

  /** @internal */
  getDescription(): string {
    return 'Get the largest objects in heap';
  }

  /** @internal */
  getOptions(): BaseOption[] {
    return [new SnapshotFileOption(), new OutputOption()];
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
    const largeObjects = pluginUtils.filterOutLargestObjects(
      snapshot,
      pluginUtils.isNodeWorthInspecting,
    );
    pluginUtils.printNodeListInTerminal(largeObjects);
  }
}

export default ObjectSizeRankAnalysis;
