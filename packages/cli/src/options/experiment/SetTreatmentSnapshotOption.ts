/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {ParsedArgs} from 'minimist';
import {MemLabConfig, Nullable} from '@memlab/core';

import {BaseOption, info} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';
import {
  createTransientWorkDirFromSingleHeapSnapshot,
  validateHeapSnapshotFileOrThrow,
} from './utils/ExperimentOptionsUtils';

export default class SetTreatmentWorkDirOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.TREATMENT_SNAPSHOT;
  }

  getDescription(): string {
    return 'set the single (target) snapshot of treatment run';
  }

  async parse(
    config: MemLabConfig,
    args: ParsedArgs,
  ): Promise<{treatmentWorkDirs?: Nullable<string[]>}> {
    let dirs = null;
    const optionName = this.getOptionName();
    if (optionName in args) {
      const snapshotFile = validateHeapSnapshotFileOrThrow(args[optionName]);
      dirs = [createTransientWorkDirFromSingleHeapSnapshot(snapshotFile)];
    }
    if (config.verbose && dirs && dirs[0]) {
      info.lowLevel(`creating treatment working directory: ${dirs[0]}`);
    }
    return {treatmentWorkDirs: dirs};
  }
}
