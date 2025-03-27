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
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

export default class SkipExtraOperationOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.SKIP_EXTRA_OPS;
  }

  getDescription(): string {
    return 'skip doing extra interactions (e.g., scrolling and waiting) on target and final page';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (
      args[this.getOptionName()] ||
      args[optionConstants.optionNames.SKIP_EXTRA_OP]
    ) {
      config.skipExtraOps = true;
    }
  }
}
