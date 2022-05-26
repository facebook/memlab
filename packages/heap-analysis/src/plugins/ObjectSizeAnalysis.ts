/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {HeapAnalysisOptions} from '../PluginUtils';

import {BaseOption} from '@memlab/core';
import BaseAnalysis from '../BaseAnalysis';
import pluginUtils from '../PluginUtils';
import SnapshotFileOption from '../options/HeapAnalysisSnapshotFileOption';

class ObjectSizeRankAnalysis extends BaseAnalysis {
  getCommandName(): string {
    return 'object-size';
  }

  getDescription(): string {
    return 'Get the largest objects in heap';
  }

  getOptions(): BaseOption[] {
    return [new SnapshotFileOption()];
  }

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
