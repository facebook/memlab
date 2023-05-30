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
import type {MemLabConfig, Nullable} from '@memlab/core';

import {BaseOption} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';
import {extractAndCheckWorkDirs} from './ExperimentOptionUtils';

export default class SetTreatmentWorkDirOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.TREATMENT_WORK_DIR;
  }

  getDescription(): string {
    return 'set the working directory of the treatment run';
  }

  async parse(
    config: MemLabConfig,
    args: ParsedArgs,
  ): Promise<{treatmentWorkDirs?: Nullable<string[]>}> {
    const dirs = extractAndCheckWorkDirs(this.getOptionName(), args);
    return {treatmentWorkDirs: dirs};
  }
}
