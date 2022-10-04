/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {IClusterStrategy, LeakTrace} from '../lib/Types';

import ClusterUtils from './ClusterUtils';
import TraceSimilarityStrategy from './strategies/TraceSimilarityStrategy';
import MLTraceSimilarityStrategy from './strategies/MLTraceSimilarityStrategy';
import config from '../lib/Config';

export default class SequentialClustering {
  private existingRepresentativeTraces: LeakTrace[] = [];
  private traceSimilarity: IClusterStrategy;

  constructor() {
    this.traceSimilarity = config.isMLClustering
      ? new MLTraceSimilarityStrategy()
      : new TraceSimilarityStrategy();
  }

  public cluster(newLeakTraces: LeakTrace[]): LeakTrace[][] {
    const {allClusters: clusters} = this.traceSimilarity.diffTraces(
      newLeakTraces,
      [],
    );
    const representativeTracesToAdd = [];

    // Second round of clustering and relabeling
    outer: for (let i = 0; i < clusters.length; i++) {
      const newRepTrace = clusters[i][0];
      for (const exRepTrace of this.existingRepresentativeTraces) {
        if (ClusterUtils.isSimilarTrace(exRepTrace, newRepTrace)) {
          clusters[i].unshift(exRepTrace);
          continue outer;
        }
      }
      representativeTracesToAdd.push(newRepTrace);
    }
    this.existingRepresentativeTraces = [
      ...this.existingRepresentativeTraces,
      ...representativeTracesToAdd,
    ];
    return clusters;
  }
}
