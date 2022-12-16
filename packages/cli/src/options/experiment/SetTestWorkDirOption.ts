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
import type {AnyRecord, MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

export default class SetTestWorkDirOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.TEST_WORK_DIR;
  }

  getDescription(): string {
    return 'set the working directory of the test (treatment) run';
  }

  async parse(
    config: MemLabConfig,
    args: ParsedArgs,
  ): Promise<{testWorkDir?: string}> {
    const name = this.getOptionName();
    const ret: AnyRecord = {};
    if (args[name]) {
      ret.testWorkDir = args[name];
    }
    return ret;
  }
}
