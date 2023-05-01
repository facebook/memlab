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
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

export default class SetTraceContainsFilterOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.TRACE_CONTAINS;
  }

  getDescription(): string {
    return 'set the node name or edge name to filter leak traces that contain the name';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const filterName = args[this.getOptionName()];
    if (filterName != null) {
      config.filterTraceByName = filterName;
    }
  }
}
