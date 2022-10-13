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
import {MemLabConfig, utils} from '@memlab/core';
import {BaseOption} from '@memlab/core';
import optionConstants from './lib/OptionConstant';

export default class MLClusteringMaxDFOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.ML_CLUSTERING_MAX_DF;
  }

  getDescription(): string {
    return 'set percentage based max document frequency for limiting the terms that appear too often';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const name = this.getOptionName();
    const arg = args[name];
    if (arg) {
      const clusteringMaxDFStr = arg;
      const clusteringMaxDF = parseFloat(clusteringMaxDFStr);
      if (
        !isNaN(clusteringMaxDF) &&
        clusteringMaxDF >= 0 &&
        clusteringMaxDF <= 1
      ) {
        config.mlMaxDF = clusteringMaxDF;
      } else {
        utils.haltOrThrow(
          `ml-clustering-max-df is not number between [0, 1]. ml-clustering-max-df=${clusteringMaxDF}`,
        );
      }
    }
  }
}
