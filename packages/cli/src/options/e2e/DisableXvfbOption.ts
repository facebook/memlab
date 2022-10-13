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

export default class DisableXvfbOption extends BaseOption {
  getOptionName(): string {
    return OptionNames.DISABLE_XVFB;
  }

  getDescription(): string {
    return 'disable Xvfb (X virtual framebuffer) for simulating headful browser rendering';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()]) {
      config.useXVFB = false;
    }
  }
}
