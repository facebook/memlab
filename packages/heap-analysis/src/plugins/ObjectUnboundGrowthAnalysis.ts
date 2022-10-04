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

import {analysis, config, utils, BaseOption} from '@memlab/core';
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
    await analysis.checkUnbound(opt);
  }
}

export default ObjectUnboundGrowthAnalysis;
