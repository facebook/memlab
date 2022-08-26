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

export default class DebugOption extends BaseOption {
  getOptionName(): string {
    return 'debug';
  }

  getDescription(): string {
    return 'enable manual debugging';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args['debug']) {
      config.isManualDebug = true;
    }
  }
}
