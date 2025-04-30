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

export default class DisplayLeakOutlinesOptions extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.DISPLAY_LEAK_OUTLINES;
  }

  getDescription(): string {
    return (
      'display leaked component outlines in headful browser; ' +
      `use this with the --${optionConstants.optionNames.HEADFUL} option`
    );
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()]) {
      config.displayLeakOutlines = true;
    }
  }
}
