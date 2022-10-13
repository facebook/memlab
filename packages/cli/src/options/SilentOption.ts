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
import optionConstants from './lib/OptionConstant';

export default class SilentOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.SILENT;
  }

  getOptionShortcut(): string {
    return optionConstants.optionShortcuts.S;
  }

  getDescription(): string {
    return 'mute all terminal output';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()] || args[this.getOptionShortcut()]) {
      config.muteConsole = true;
    }
  }
}
