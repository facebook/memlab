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

export default class MLClusteringOption extends BaseOption {
  getOptionName(): string {
    return OPTION_NAME.ML_CLUSTERING;
  }

  getDescription(): string {
    return 'use machine learning algorithms for clustering leak traces (by default, traces are clustered by heuristics)';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args['ml-clustering']) {
      config.isMLClustering = true;
    }
  }
}
