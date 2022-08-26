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

export default class VerboseOption extends BaseOption {
  getOptionName(): string {
    return 'verbose';
  }

  getOptionShortcut(): string | null {
    return 'v';
  }

  getDescription(): string {
    return 'show more details';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args.verbose || args.v) {
      config.verbose = true;
    }
  }
}
