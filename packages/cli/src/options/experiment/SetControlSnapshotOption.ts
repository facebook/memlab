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

export default class SetControlWorkDirOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.CONTROL_SNAPSHOT;
  }

  getDescription(): string {
    return 'set the single (target) snapshot of control run';
  }

  async parse(
    config: MemLabConfig,
    args: ParsedArgs,
  ): Promise<{controlWorkDirs?: Nullable<string[]>}> {
    let dirs = null;
    const optionName = this.getOptionName();
    if (optionName in args) {
      const snapshotFile = validateHeapSnapshotFileOrThrow(args[optionName]);
      dirs = [createTransientWorkDirFromSingleHeapSnapshot(snapshotFile)];
    }
    if (config.verbose && dirs && dirs[0]) {
      info.lowLevel(`creating control working directory: ${dirs[0]}`);
    }
    return {controlWorkDirs: dirs};
  }
}
