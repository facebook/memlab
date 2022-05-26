/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {HeapAnalysisOptions} from '../PluginUtils';

import {analysis, BaseOption} from '@memlab/core';
import BaseAnalysis from '../BaseAnalysis';
import pluginUtils from '../PluginUtils';
import SnapshotFileOption from '../options/HeapAnalysisSnapshotFileOption';

class ObjectShapeAnalysis extends BaseAnalysis {
  getCommandName(): string {
    return 'shape';
  }

  getDescription(): string {
    return 'List the shapes that retained most memory';
  }

  getOptions(): BaseOption[] {
    return [new SnapshotFileOption()];
  }

  async process(options: HeapAnalysisOptions): Promise<void> {
    const snapshotPath = pluginUtils.getSnapshotFileForAnalysis(options);
    await analysis.breakDownMemoryByShapes({file: snapshotPath});
  }
}

export default ObjectShapeAnalysis;
