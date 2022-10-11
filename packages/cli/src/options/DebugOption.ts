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
import {OPTION_NAME} from "./constant";

export default class DebugOption extends BaseOption {
  getOptionName(): string {
    return OPTION_NAME.DEBUG;
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
