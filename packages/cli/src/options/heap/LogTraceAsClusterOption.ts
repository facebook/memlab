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

export default class LogTraceAsClusterOption extends BaseOption {
  getOptionName(): string {
    return 'save-trace-as-unclassified-cluster';
  }

  getDescription(): string {
    return 'dump each retainer trace as an unclassified trace cluster';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()]) {
      config.logUnclassifiedClusters = true;
    }
  }
}
