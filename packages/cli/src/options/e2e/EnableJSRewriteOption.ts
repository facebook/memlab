/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class EnableJSRewriteOption extends BaseOption {
  getOptionName(): string {
    return 'rewrite-js';
  }

  getDescription(): string {
    return 'enable instrument JavaScript code in browser';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()]) {
      config.instrumentJS = true;
    }
  }
}
