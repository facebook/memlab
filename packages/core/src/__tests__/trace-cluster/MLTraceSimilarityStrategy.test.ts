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

function getTotalTraceCount(clusters: LeakTrace[][]): number {
  return clusters.reduce((sum, cluster) => sum + cluster.length, 0);
}

test('diffTraces includes each trace in a cluster exactly once', () => {
  const strategy = new MLTraceSimilarityStrategy();
  const trace: LeakTrace = [
    {kind: 'node', id: 1, name: 'LeakedObject', type: 'object'},
    {kind: 'edge', name_or_index: 'next', type: 'property'},
  ];

  // a single trace still forms one cluster, and the representative trace
  // must not be duplicated inside it
  const single = strategy.diffTraces([trace]);
  expect(getTotalTraceCount(single.allClusters)).toBe(1);

  // identical traces are clustered together; each trace should appear in
  // the result exactly once
  const traces = [trace, [...trace], [...trace]];
  const result = strategy.diffTraces(traces);
  expect(getTotalTraceCount(result.allClusters)).toBe(traces.length);
});
