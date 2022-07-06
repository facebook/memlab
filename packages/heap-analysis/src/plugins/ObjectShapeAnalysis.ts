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

import {analysis, BaseOption, utils} from '@memlab/core';
import BaseAnalysis from '../BaseAnalysis';
import pluginUtils from '../PluginUtils';
import SnapshotFileOption from '../options/HeapAnalysisSnapshotFileOption';

class ObjectShapeAnalysis extends BaseAnalysis {
  getCommandName(): string {
    return 'shape';
  }

  /** @internal */
  getDescription(): string {
    return 'List the shapes that retained most memory';
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
    const snapshotPath = pluginUtils.getSnapshotFileForAnalysis(options);
    await analysis.breakDownMemoryByShapes({file: snapshotPath});
  }
}

export default ObjectShapeAnalysis;
