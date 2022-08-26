/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class TraceAllObjectsOption extends BaseOption {
  getOptionName(): string {
    return 'trace-all-objects';
  }

  getDescription(): string {
    return 'dump retainer trace for all allocated objects (ignore the leak filter)';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()]) {
      config.oversizeObjectAsLeak = true;
      config.oversizeThreshold = 0;
    }
  }
}
