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

export default class MLClusteringLinkageMaxDistanceOption extends BaseOption {
  getOptionName(): string {
    return OptionNames.ML_LINKAGE_MAX_DIST;
  }

  getDescription(): string {
    return 'set linkage max distance value for clustering. The value should be between [0, 1] inclusive.';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args['ml-linkage-max-dist']) {
      const linkageMaxDist = args['ml-linkage-max-dist'];
      const linkageMaxDistNum = parseFloat(linkageMaxDist);
      if (
        !isNaN(linkageMaxDistNum) &&
        linkageMaxDistNum >= 0 &&
        linkageMaxDistNum <= 1
      ) {
        config.mlClusteringLinkageMaxDistance = linkageMaxDistNum;
      } else {
        utils.haltOrThrow(
          `ml-linkage-max-dist is not number between [0, 1]. ml-linkage-max-dist=${linkageMaxDist}`,
        );
      }
    }
  }
}
