/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';
import optionConstants from './lib/OptionConstant';

export default class SetMaxClusterSampleSizeOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.MAX_CLUSTER_SAMPLE_SIZE;
  }

  getDescription(): string {
    return (
      'specify the max number of leak traces as input to leak trace ' +
      'clustering algorithm. Big sample size will preserve more complete ' +
      'inforrmation, but may risk out-of-memory crash.'
    );
  }

  getExampleValues(): string[] {
    return ['5000', '10000'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()]) {
      const sampleSize = parseInt(args[this.getOptionName()], 10);
      if (!isNaN(sampleSize)) {
        config.maxSamplesForClustering = sampleSize;
      }
    }
  }
}
