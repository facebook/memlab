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

export default class InteractionOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.INTERACTION;
  }

  getDescription(): string {
    return 'set name for onboarded interaction';
  }

  getExampleValues(): string[] {
    return ['watch', 'campaign-tab'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const name = this.getOptionName();
    const arg = args[name];
    if (arg) {
      config.targetTab = Array.isArray(arg) ? arg[arg.length - 1] : arg;
    }
  }
}
