/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

const cache = new Map();
const buildIntersection = (
  tfidfs: Record<string, number>[],
  i: number,
  j: number,
) => {
  const intersection = [];
  if (!cache.has(i)) {
    cache.set(i, Object.keys(tfidfs[i]));
  }
  if (!cache.has(j)) {
    cache.set(j, Object.keys(tfidfs[j]));
  }
  const [keys, tfidf] =
    cache.get(i).length > cache.get(j).length
      ? [cache.get(j), tfidfs[i]]
      : [cache.get(i), tfidfs[j]];
  for (const k of keys) {
    if (tfidf[k]) {
      intersection.push(k);
    }
  }
  return intersection;
};

export const distance = (tfidfs: Record<string, number>[]) => {
  const n = tfidfs.length;
  const distances = new Float32Array((n * (n - 1)) / 2);
  let distIdx = 0;

  const dotProducs = tfidfs.map(atfidf =>
    Object.values(atfidf).reduce((sum, v) => sum + v * v, 0),
  );

  for (let i = 0; i < tfidfs.length; i++) {
    const a = tfidfs[i];
    for (let j = i + 1; j < tfidfs.length; j++) {
      const b = tfidfs[j];
      const intersection = buildIntersection(tfidfs, i, j);
      const dotProdOfCommons = intersection.reduce(
        (sum, vidx) => sum + a[vidx] * b[vidx],
        0,
      );
      // TODO make it pluggable to use other distance measures like euclidean, manhattan
      const cosineSimilarity =
        1 -
        dotProdOfCommons /
          (Math.sqrt(dotProducs[i]) / Math.sqrt(dotProducs[j]));
      distances[distIdx] = cosineSimilarity;
      distIdx++;
    }
  }
  cache.clear();
  return distances;
};
