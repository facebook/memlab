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
import {OptionNames} from "./constant";

export default class MLClusteringMaxDFOption extends BaseOption {
  getOptionName(): string {
    return OptionNames.ML_CLUSTERING_MAX_DF;
  }

  getDescription(): string {
    return 'set percentage based max document frequency for limiting the terms that appear too often';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args['ml-clustering-max-df']) {
      const clusteringMaxDFStr = args['ml-clustering-max-df'];
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
