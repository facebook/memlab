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

export default class HeadfulBrowserOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.HEADFUL;
  }

  getDescription(): string {
    return 'start the browser in headful mode, but default it is headless';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()]) {
      config.isHeadfulBrowser = true;
    }
  }
}
