/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {LeakTrace} from '../../lib/Types';
import MLTraceSimilarityStrategy from '../../trace-cluster/strategies/MLTraceSimilarityStrategy';

function newTrace(): LeakTrace {
  return [
    {kind: 'node', id: 1, name: 'LeakedObject', type: 'object'},
    {kind: 'edge', name_or_index: 'next', type: 'property'},
  ];
}

function getTotalTraceCount(clusters: LeakTrace[][]): number {
  return clusters.reduce((sum, cluster) => sum + cluster.length, 0);
}

test('diffTraces includes each trace in a cluster exactly once', () => {
  const strategy = new MLTraceSimilarityStrategy();

  // a single trace still forms one cluster, and the representative trace
  // must not be duplicated inside it
  const single = strategy.diffTraces([newTrace()]);
  expect(getTotalTraceCount(single.allClusters)).toBe(1);

  // identical traces are clustered together; each trace should appear in
  // the result exactly once
  const traces = [newTrace(), newTrace(), newTrace()];
  const result = strategy.diffTraces(traces);
  expect(getTotalTraceCount(result.allClusters)).toBe(traces.length);
  for (const cluster of result.allClusters) {
    expect(new Set(cluster).size).toBe(cluster.length);
  }
});

test('diffTraces keeps the representative trace at index 0', () => {
  const strategy = new MLTraceSimilarityStrategy();
  const traces = [newTrace(), newTrace(), newTrace()];
  const {allClusters} = strategy.diffTraces(traces);

  // HAC labels every trace in a cluster with the largest index in that
  // cluster, so the representative of these identical traces is the last one.
  // Downstream code (e.g. NormalizedTrace.clusterPaths) reads cluster[0] as
  // the representative trace of the cluster.
  expect(allClusters.length).toBe(1);
  expect(allClusters[0][0]).toBe(traces[traces.length - 1]);
});
