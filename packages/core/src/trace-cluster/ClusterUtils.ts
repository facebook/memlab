/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {LeakTrace} from '../lib/Types';
import ClusterUtils from './ClusterUtilsHelper';
import ClusteringHeuristics from './ClusteringHeuristics';

export default ClusterUtils.initialize(ClusteringHeuristics);

/**
 * const elements = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
 * randomChunks(elements, 3) -> [[4, 8, 3], [9, 5, 1], [2, 6, 7, 10]]
 * @internal
 */
export const randomChunks = <T>(items: T[], n: number) => {
  const array = [...items];
  const size = Math.floor(array.length / n);
  const chunks = [];
  for (let i = 0; i < n - 1; i++) {
    const chunk: T[] = [];
    for (let j = 0; j < size; j++) {
      const idx = Math.floor(Math.random() * array.length);
      chunk[j] = array[idx];
      array.splice(idx, 1);
    }
    chunks.push(chunk);
  }
  chunks.push(array);
  return chunks;
};

/**
 * chunks(elements, 3) -> [[1, 2, 3], [4, 5, 6], [7, 8, 9, 10]]
 * @internal
 */
export const chunks = <T>(items: T[], n: number) => {
  const array = [...items];
  const size = Math.floor(array.length / n);
  const chunks = [];
  for (let i = 0; i < n - 1; i++) {
    const chunk = array.splice(0, size);
    chunks.push(chunk);
  }
  chunks.push(array);
  return chunks;
};

/** @internal*/
export const lastNodeFromTrace = (trace: LeakTrace) => trace[trace.length - 1];
