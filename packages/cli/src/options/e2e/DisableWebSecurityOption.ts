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

export default class DisableWebSecurityOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.DISABLE_WEB_SECURITY;
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
