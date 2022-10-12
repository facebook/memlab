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
import {OptionNames, OptionShortcuts} from "./constant";

export default class HelperOption extends BaseOption {
  getOptionName(): string {
    return OptionNames.HELP;
  }

  getOptionShortcut(): string {
    return OptionShortcuts.H;
  }

  getDescription(): string {
    return 'print helper text';
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async parse(_config: MemLabConfig, _args: ParsedArgs): Promise<void> {
    // the logic is done in dispatcher
  }
}
