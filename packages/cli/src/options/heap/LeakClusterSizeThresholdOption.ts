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
import {OPTION_NAME} from "../constant";

export default class LeakClusterSizeThresholdOption extends BaseOption {
  getOptionName(): string {
    return OPTION_NAME.IGNORE_LEAK_CLUSTER_SIZE_BELOW;
  }

  getDescription(): string {
    return 'ignore memory leaks with aggregated retained size smaller than the threshold';
  }

  getExampleValues(): string[] {
    return ['1000', '1000000'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()]) {
      const sizeThreshold = parseInt(args[this.getOptionName()], 10);
      if (!isNaN(sizeThreshold)) {
        config.clusterRetainedSizeThreshold = sizeThreshold;
      }
    }
  }
}
