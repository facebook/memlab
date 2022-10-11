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
import {OPTION_NAME, OPTION_SHORTCUT} from "./constant";

export default class SilentOption extends BaseOption {
  getOptionName(): string {
    return OPTION_NAME.SILENT;
  }

  getOptionShortcut(): string {
    return OPTION_SHORTCUT.S;
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
