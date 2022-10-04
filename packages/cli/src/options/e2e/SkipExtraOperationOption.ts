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

export default class SkipExtraOperationOption extends BaseOption {
  getOptionName(): string {
    return 'skip-extra-ops';
  }

  getDescription(): string {
    return 'skip doing extra interactions (e.g., scrolling and waiting) on target and final page';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args['skip-extra-ops'] || args['skip-extra-op']) {
      config.skipExtraOps = true;
    }
  }
}
