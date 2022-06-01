/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 *
 * @format
 */

import type {IClusterStrategy, LeakTrace, TraceDiff} from '../../lib/Types';
import ClusterUtils from '../ClusterUtils';

// cluster by putting similar traces together
export default class TraceSimilarityStrategy implements IClusterStrategy {
  public diffTraces(
    newTraces: LeakTrace[],
    existingTraces: LeakTrace[],
  ): TraceDiff {
    // duplicated cluster to remove
    const staleClusters: LeakTrace[] = [];
    // new cluster to save
    const clustersToAdd: LeakTrace[] = [];
    // all clusters, with duplicated cluters in the same sub-array
    const clusters: LeakTrace[][] = [];

    // consolidating existing clusters
    if (existingTraces.length > 0) {
      clusters.push([existingTraces[0]]);
      outer: for (let i = 1; i < existingTraces.length; ++i) {
        const traceToCheck = existingTraces[i];
        for (let j = 0; j < clusters.length; ++j) {
          const repTrace = clusters[j][0];
          if (TraceSimilarityStrategy.isSimilarTrace(repTrace, traceToCheck)) {
            staleClusters.push(traceToCheck);
            clusters[j].push(traceToCheck);
            continue outer;
          }
        }
        clusters.push([traceToCheck]);
      }
    }

    // checking new clusters
    outer: for (let i = 0; i < newTraces.length; ++i) {
      const traceToCheck = newTraces[i];
      for (let j = 0; j < clusters.length; ++j) {
        const repTrace = clusters[j][0];
        if (TraceSimilarityStrategy.isSimilarTrace(repTrace, traceToCheck)) {
          clusters[j].push(traceToCheck);
          continue outer;
        }
      }
      clustersToAdd.push(traceToCheck);
      clusters.push([traceToCheck]);
    }

    return {staleClusters, clustersToAdd, allClusters: clusters};
  }

  static isSimilarTrace(t1: LeakTrace, t2: LeakTrace): boolean {
    return ClusterUtils.isSimilarTrace(t1, t2);
  }
}
