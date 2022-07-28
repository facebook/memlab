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

export default class MLClusteringOption extends BaseOption {
  getOptionName(): string {
    return 'ml-clustering';
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
