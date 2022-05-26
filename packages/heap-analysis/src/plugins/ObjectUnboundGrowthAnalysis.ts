/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {HeapAnalysisOptions} from '../PluginUtils';

import {analysis, config, BaseOption} from '@memlab/core';
import BaseAnalysis from '../BaseAnalysis';
import SnapshotDirectoryOption from '../options/HeapAnalysisSnapshotDirectoryOption';
import pluginUtils from '../PluginUtils';

class ObjectUnboundGrowthAnalysis extends BaseAnalysis {
  getCommandName(): string {
    return 'unbound-object';
  }

  getDescription(): string {
    return 'Check unbound object growth';
  }

  getOptions(): BaseOption[] {
    return [new SnapshotDirectoryOption()];
  }

  async process(options: HeapAnalysisOptions): Promise<void> {
    const snapshotDir = pluginUtils.getSnapshotDirForAnalysis(options);
    const opt = snapshotDir ? {minSnapshots: 2, snapshotDir} : {};
    config.chaseWeakMapEdge = false;
    await analysis.checkUnbound(opt);
  }
}

export default ObjectUnboundGrowthAnalysis;
