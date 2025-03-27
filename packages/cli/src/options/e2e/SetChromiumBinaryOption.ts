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
import {MemLabConfig} from '@memlab/core';

import {utils, BaseOption} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

export default class SetChromiumBinaryOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.CHROMIUM_BINARY;
  }

  getDescription(): string {
    return 'set the chromium binary for E2E run';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const name = this.getOptionName();
    const arg = args[name];
    if (arg) {
      utils.setChromiumBinary(config, arg);
    }
  }
}
