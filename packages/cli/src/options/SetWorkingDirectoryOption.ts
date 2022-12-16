/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {ParsedArgs} from 'minimist';
import {AnyRecord, MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';
import optionConstants from './lib/OptionConstant';

export default class SetWorkingDirectoryOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.WORK_DIR;
  }

  getDescription(): string {
    return 'set the working directory of the current run';
  }

  async parse(
    config: MemLabConfig,
    args: ParsedArgs,
  ): Promise<{workDir?: string}> {
    const name = this.getOptionName();
    const ret: AnyRecord = {};
    const workDir = args[name];
    if (workDir) {
      ret.workDir = workDir;
    }
    return ret;
  }
}
