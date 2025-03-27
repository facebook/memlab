/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {AnyValue, IClusterStrategy, LeakTrace} from '../lib/Types';

import {chunks, randomChunks, lastNodeFromTrace} from './ClusterUtils';
import TraceSimilarityStrategy from './strategies/TraceSimilarityStrategy';
import MLTraceSimilarityStrategy from './strategies/MLTraceSimilarityStrategy';
import config from '../lib/Config';
import utils from '../lib/Utils';
import info from '../lib/Console';

type ClusterOption = {
  numberOfIteration?: number;
  numberOfTraceToRetainInCluster?: number;
};

export default class MultiIterationSeqClustering {
  private traceSimilarity: IClusterStrategy;

  constructor() {
    this.traceSimilarity = config.isMLClustering
      ? new MLTraceSimilarityStrategy()
      : new TraceSimilarityStrategy();
  }

  public cluster(
    newLeakTraces: LeakTrace[],
    options: ClusterOption = {},
  ): LeakTrace[][] {
    const maxNumOfSampleTraceInCluster = positiveIntOrDefaultValue(
      options.numberOfTraceToRetainInCluster,
      Infinity,
    );
    const numIteration = positiveIntOrDefaultValue(
      options.numberOfIteration,
      1,
    );
    if (config.verbose) {
      info.lowLevel(
        `maxNumOfSampleTraceInCluster: ${maxNumOfSampleTraceInCluster}`,
      );
      info.lowLevel(`numIteration: ${numIteration}`);
    }
    // build trace and id mapping
    const traceId2RepTraceId = new Map<number, number>();
    const traceId2Trace = new Map<number, LeakTrace>();
    for (const trace of newLeakTraces) {
      traceId2Trace.set(traceId(trace), trace);
    }

    // split all traces into several batches
    const splitFn = config.seqClusteringIsRandomChunks ? randomChunks : chunks;
    const traceGroups = splitFn(newLeakTraces, numIteration);

    let clusteredTraceSamples: LeakTrace[] = [];
    for (let iter = 0; iter < numIteration; ++iter) {
      info.overwrite(`Iteration: ${iter + 1}`);
      // mix the current traces to cluster with all clustered trace samples
      const curTraceGroup = traceGroups[iter].concat(clusteredTraceSamples);
      // cluster the trace group
      const {allClusters: clusters} = this.traceSimilarity.diffTraces(
        curTraceGroup,
        [],
      );
      // assign trace id to representative trace id
      updateTraceId2RepTraceIdMap(clusters, traceId2RepTraceId);
      // sample each group
      for (let i = 0; i < clusters.length; ++i) {
        clusters[i] = clusters[i].slice(0, maxNumOfSampleTraceInCluster);
      }
      // update samples
      clusteredTraceSamples = clusters.reduce(
        (acc, cluster) => acc.concat(cluster),
        [],
      );
    }

    // rebuild full clusters based on the mappings
    const repTraceId2Cluster = new Map<number, LeakTrace[]>();
    for (const id of traceId2RepTraceId.keys()) {
      const repTraceId = traceId2RepTraceId.get(id) as number;
      if (!repTraceId2Cluster.has(repTraceId)) {
        repTraceId2Cluster.set(repTraceId, []);
      }
      const cluster = repTraceId2Cluster.get(repTraceId) as LeakTrace[];
      if (cluster.length === 0) {
        const repTrace = traceId2Trace.get(repTraceId) as LeakTrace;
        cluster.push(repTrace);
      }
      if (id !== repTraceId) {
        const trace = traceId2Trace.get(id) as LeakTrace;
        cluster.push(trace);
      }
    }
    return Array.from(repTraceId2Cluster.values());
  }
}

function traceId(trace: LeakTrace): number {
  const lastNode = lastNodeFromTrace(trace);
  if (lastNode.id == null) {
    throw utils.haltOrThrow('last node id missing');
  }
  return lastNode.id;
}

function updateTraceId2RepTraceIdMap(
  clusters: LeakTrace[][],
  traceId2RepTraceId: Map<number, number>,
): Map<number, number> {
  for (const cluster of clusters) {
    const repTrace = cluster[0];
    for (const trace of cluster) {
      traceId2RepTraceId.set(traceId(trace), traceId(repTrace));
    }
  }
  // update trace id to representative trace id closure
  for (const id of traceId2RepTraceId.keys()) {
    const queue: number[] = [];
    let cur = id;
    let repTraceId = traceId2RepTraceId.get(cur) as number;
    while (repTraceId !== cur) {
      queue.push(cur);
      cur = repTraceId;
      repTraceId = traceId2RepTraceId.get(cur) as number;
    }
    for (const idInQueue of queue) {
      traceId2RepTraceId.set(idInQueue, repTraceId);
    }
  }
  return traceId2RepTraceId;
}

function positiveIntOrDefaultValue(v: AnyValue, d: number): number {
  return typeof v !== 'number' || v <= 0 ? d : v;
}
