/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class SetContinuousTestOption extends BaseOption {
  getOptionName(): string {
    return 'sc';
  }

  getDescription(): string {
    return 'set to continuous test mode';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args['ContinuousTest'] || args[this.getOptionName()]) {
      config.isContinuousTest = true;
    }
  }
}
