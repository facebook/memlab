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
import type {AnyRecord, MemLabConfig, Optional} from '@memlab/core';
import {BaseOption} from '@memlab/core';
import optionConstants from './lib/OptionConstant';

const DEFAULT_NUM_RUNS = 10;

export default class NumberOfRunsOption extends BaseOption {
  private defaultRunNumber = DEFAULT_NUM_RUNS;

  constructor(runNumber = DEFAULT_NUM_RUNS) {
    super();
    this.defaultRunNumber = runNumber;
  }

  getOptionName(): string {
    return optionConstants.optionNames.RUN_NUM;
  }

  getDescription(): string {
    return 'set number of runs';
  }

  getExampleValues(): string[] {
    return ['5'];
  }

  static getParsedOption(configFromOptions: Optional<AnyRecord>): number {
    const {numOfRuns} = configFromOptions ?? {};
    const n = parseInt(`${numOfRuns}`, 10);
    return isNaN(n) ? DEFAULT_NUM_RUNS : n;
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<AnyRecord> {
    const ret = Object.create(null);
    const name = this.getOptionName();
    ret.numOfRuns = args[name] != null ? args[name] | 0 : this.defaultRunNumber;
    return ret;
  }
}
