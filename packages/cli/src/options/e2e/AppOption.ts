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
import {OptionNames} from '../constant';

export default class AppOption extends BaseOption {
  getOptionName(): string {
    return OptionNames.APP;
  }

  getDescription(): string {
    return 'set name for onboarded web application';
  }

  getExampleValues(): string[] {
    return ['comet', 'ads-manager'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const name = this.getOptionName();
    const arg = args[name];
    if (arg) {
      config.targetApp = Array.isArray(arg) ? arg[arg.length - 1] : arg;
    }
  }
}
