/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class DisableXvfbOption extends BaseOption {
  getOptionName(): string {
    return 'disable-xvfb';
  }

  getDescription(): string {
    return 'disable Xvfb (X virtual framebuffer) for simulating headful browser rendering';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args['disable-xvfb']) {
      config.useXVFB = false;
    }
  }
}
