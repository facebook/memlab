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

export default class DisableWebSecurityOption extends BaseOption {
  getOptionName(): string {
    return OptionNames.DISABLE_WEB_SECURITY;
  }

  getDescription(): string {
    return (
      'disable web security in Chromium to enable cross domain requests; ' +
      'web security is enabled by default'
    );
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()]) {
      config.disableWebSecurity = true;
    }
  }
}
