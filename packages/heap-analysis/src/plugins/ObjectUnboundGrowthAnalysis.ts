/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
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
