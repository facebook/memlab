/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

const condensedIndex = (n: number, i: number, j: number): number => {
  if (i > j) {
    return condensedIndex(n, j, i);
  }
  // to get distance between (i, j) think of this sequence.
  // (n - 1) + (n - 2) + ... + (n - i) + (j - i) - 1
  return n * i - (i * (i + 1)) / 2 + (j - i - 1);
};

function getRootLabel(array: Uint32Array, idx: number): number {
  let rootIdx = idx;
  while (array[rootIdx] !== rootIdx) {
    rootIdx = array[rootIdx];
  }
  return rootIdx;
}

/**
 *
 * @param {*} nDocs number of docs
 * @param {*} D condenced distance matrix
 * @returns labels - list of doc ids as clusters
 */
export const cluster = (
  nDocs: number,
  condensedDistanceMatrix: Float32Array,
  maxDistanceThreshold: number,
) => {
  if (nDocs <= 1) return [0];

  const condencedDistanceMatrixCopy = new Float32Array(condensedDistanceMatrix);
  const sizeOfClusters = new Uint32Array(nDocs).fill(1);
  let chainLength = 0;
  let clusterChain: number[] = [];
  let traceAIdx = -1;
  let traceBIdx = -1;
  let currentMin = Number.MAX_SAFE_INTEGER;
  let distanceBetweenTraces: number;
  const labels = new Uint32Array(nDocs).map((_, idx) => idx);

  for (let k = 0; k < nDocs - 1; k++) {
    traceBIdx = -1;
    if (chainLength === 0) {
      for (let i = 0; i < nDocs; i++) {
        if (sizeOfClusters[i] > 0) {
          clusterChain[0] = i;
          chainLength = 1;
          break;
        }
      }
    }

    while (chainLength > 0) {
      traceAIdx = clusterChain[chainLength - 1];
      if (chainLength > 1) {
        traceBIdx = clusterChain[chainLength - 2];
        currentMin =
          condencedDistanceMatrixCopy[
            condensedIndex(nDocs, traceAIdx, traceBIdx)
          ];
      } else {
        currentMin = Number.MAX_SAFE_INTEGER;
      }

      for (let i = 0; i < nDocs; i++) {
        if (sizeOfClusters[i] == 0 || traceAIdx == i) {
          continue;
        }

        distanceBetweenTraces =
          condencedDistanceMatrixCopy[condensedIndex(nDocs, traceAIdx, i)];
        if (distanceBetweenTraces < currentMin) {
          currentMin = distanceBetweenTraces;
          traceBIdx = i;
        }
      }

      // make sure that traceA and traceB are closest to each other
      if (
        chainLength > 1 &&
        traceBIdx !== -1 &&
        traceBIdx === clusterChain[chainLength - 2]
      ) {
        break;
      }

      clusterChain[chainLength] = traceBIdx;
      chainLength = chainLength + 1;
    }

    clusterChain = [];
    chainLength = 0;

    if (currentMin > maxDistanceThreshold) {
      sizeOfClusters[traceAIdx] = 0;
      sizeOfClusters[traceBIdx] = 0;
      continue;
    }

    if (traceAIdx === -1 || traceBIdx === -1) {
      continue;
    }

    if (traceAIdx > traceBIdx) {
      [traceAIdx, traceBIdx] = [traceBIdx, traceAIdx];
    }

    const nx = sizeOfClusters[traceAIdx];
    const ny = sizeOfClusters[traceBIdx];

    labels[traceAIdx] = traceBIdx;
    sizeOfClusters[traceAIdx] = 0;
    sizeOfClusters[traceBIdx] = nx + ny;

    for (let i = 0; i < nDocs; i++) {
      const ni = sizeOfClusters[i];
      if (ni === 0 || i === traceBIdx) {
        continue;
      }

      const d_xi =
        condencedDistanceMatrixCopy[condensedIndex(nDocs, i, traceAIdx)];
      const d_yi =
        condencedDistanceMatrixCopy[condensedIndex(nDocs, i, traceBIdx)];
      const size_x = nx;
      const size_y = ny;
      // TODO make it generic to support other linkage methods like complete, weighted etc...
      const updatedDist = (size_x * d_xi + size_y * d_yi) / (size_x + size_y);
      condencedDistanceMatrixCopy[condensedIndex(nDocs, i, traceBIdx)] =
        updatedDist;
    }
  }

  return labels.map((_, idx) => getRootLabel(labels, idx));
};
