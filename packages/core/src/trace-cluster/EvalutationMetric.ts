/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

////////////////////////
const zip = (arr1: number[], arr2: number[]) =>
  arr1.reduce<[number, number][]>((ret, el, idx) => {
    ret.push([el, arr2[idx]]);
    return ret;
  }, []);

type ArrayLike<T> = T[] | T[][];

/*
  countUnique returns array of count of unique items for given array of numbers.
  For example, countUnique([1, 2, 3, 3, 2]) returns [['1', '2', '3'], [1, 2, 2]].
    countUnique([[1, 2], [2, 3], [2, 3]]) returns [['1,2', '2,3'], [1, 2]].
*/
const countUnique = <T>(arr: ArrayLike<T> = []): [string[], number[]] => {
  const key = (el: ArrayLike<T>[0]): string => {
    if (Array.isArray(el)) {
      return el.join(',');
    }
    return `${el}`;
  };

  const map = new Map<string, number>();

  arr.forEach(el => {
    const k = key(el);
    if (map.has(key(el))) {
      map.set(k, (map.get(k) as number) + 1);
    } else {
      map.set(k, 1);
    }
  });

  return [Array.from(map.keys()), Array.from(map.values())];
};
const entropy = (labels: ArrayLike<number> = []): number => {
  const nLabels = labels.length;

  if (nLabels <= 1) return 0;

  const [, counts] = countUnique(labels);

  const probabilities = counts.map(c => c / nLabels);
  const nClassess = probabilities.filter(el => el !== 0).length;

  if (nClassess <= 1) return 0;

  let ent = 0.0;

  for (const prob of probabilities) {
    ent -= prob * Math.log(prob);
  }

  return ent;
};

const homogeneity = (
  trueLabels: number[] = [],
  predictedLabels: number[] = [],
): number => {
  const trueLabelEntropy = entropy(trueLabels);

  if (trueLabelEntropy == 0) return 1;

  // Combine two lists into a list of tuples which will be used for conditional Entropy.
  const joined = zip(trueLabels, predictedLabels);
  const joinedEntropy = entropy(joined);
  const predictedLabelEntropy = entropy(predictedLabels);

  // Conditional Entropy (Chain rule) - https://en.wikipedia.org/wiki/Conditional_entropy
  // H(X|Y) = H(X,Y) - H(X)
  const conditionalEntropy = joinedEntropy - predictedLabelEntropy;

  const h = 1 - conditionalEntropy / trueLabelEntropy;

  return h;
};

const completeness = (
  trueLabels: number[],
  predictedLabels: number[],
): number => {
  const predictedLabelEntropy = entropy(predictedLabels);

  if (predictedLabelEntropy == 0) return 1;

  // # Combine two lists into a list of tuples.
  // # For example, classes [1, 3] and clusters [20, 30] become [(1, 20), (3, 30)].
  const joined = zip(trueLabels, predictedLabels);
  const joinedEntropy = entropy(joined);
  const trueLabelEntropy = entropy(trueLabels);
  const conditionalEntropy = joinedEntropy - trueLabelEntropy;

  const c = 1 - conditionalEntropy / predictedLabelEntropy;

  return c;
};

/*
  Ratio of weight attributed to homogeneity vs completeness.
  If beta is greater than 1, completeness is weighted more strongly in the calculation.
  If beta is less than 1, homogeneity is weighted more strongly.
*/
const vMeasure = (
  trueLabels: number[],
  predictedLabels: number[],
  beta = 1,
): number => {
  const h = homogeneity(trueLabels, predictedLabels);
  const c = completeness(trueLabels, predictedLabels);
  const v = ((1 + beta) * h * c) / (beta * h + c);

  return v;
};

type ClusteredLeakTraces = Record<string, string>;

/**
 * The dataset the function takes as argument is map of key:value pairs.
 *  Key is trace_id and value is the cluster_id, which is another trace_id
 *  that represents the cluster it, belongs to
 * @param trueTraceIdLabelMap Baseline
 * @param predictedTraceIdLabelMap Predicted outcome from some clustering
 * @returns numeric evaluation ([-1:1] 1 being identical) of how close the traces are clustered using Adjust Rand Index formula.
 */
const evaluateAdjustRandScore = (
  trueTraceIdLabelMap: ClusteredLeakTraces,
  predictedTraceIdLabelMap: ClusteredLeakTraces,
): number => {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;

  const predictedTraceIDs = Object.keys(predictedTraceIdLabelMap);
  for (let i = 0; i < predictedTraceIDs.length - 1; i++) {
    for (let j = i + 1; j < predictedTraceIDs.length - 1; j++) {
      const [traceIdA, traceIdB] = [predictedTraceIDs[i], predictedTraceIDs[j]];

      const isSameInPredicted =
        predictedTraceIdLabelMap[traceIdA] ===
        predictedTraceIdLabelMap[traceIdB];
      const isSameInTrue =
        trueTraceIdLabelMap[traceIdA] === trueTraceIdLabelMap[traceIdB];

      if (isSameInPredicted && isSameInTrue) {
        truePositive++;
      } else if (!isSameInPredicted && isSameInTrue) {
        falseNegative++;
      } else if (isSameInPredicted && !isSameInTrue) {
        falsePositive++;
      } else {
        trueNegative++;
      }
    }
  }
  const n = predictedTraceIDs.length;
  // Total number of pairs
  const totalNumberOfPairs = (n * (n - 1)) / 2;
  // The formula is from https://arxiv.org/pdf/2002.03677.pdf
  const ARI =
    (totalNumberOfPairs * (truePositive + trueNegative) -
      ((truePositive + falsePositive) * (truePositive + falseNegative) +
        (falseNegative + trueNegative) * (falsePositive + trueNegative))) /
    (Math.pow(totalNumberOfPairs, 2) -
      ((truePositive + falsePositive) * (truePositive + falseNegative) +
        (falseNegative + trueNegative) * (falsePositive + trueNegative)));

  return ARI;
};

const getRepresentativeTraceMetrics = (
  trueTraceIdLabelMap: ClusteredLeakTraces,
  predictedTraceIdLabelMap: ClusteredLeakTraces,
): {omitted: number; duplicated: number} => {
  const [uniqTrueLabels] = countUnique(Object.values(trueTraceIdLabelMap));
  const nTrueLabels = uniqTrueLabels.length;
  const [uniqPredLabels] = countUnique(Object.values(predictedTraceIdLabelMap));
  const predLabelToTrueLabel = uniqPredLabels.map(
    representativeTraceId => trueTraceIdLabelMap[representativeTraceId],
  );
  const [, countsOfTrueLabelsForPredicted] = countUnique(predLabelToTrueLabel);

  const nClustersThatShouldMerge = countsOfTrueLabelsForPredicted.filter(
    count => count > 1,
  ).length;

  return {
    omitted:
      (nTrueLabels - countsOfTrueLabelsForPredicted.length) / nTrueLabels,
    duplicated: nClustersThatShouldMerge / nTrueLabels,
  };
};

export default {
  evaluateAdjustRandScore,
  vMeasure,
  completeness,
  homogeneity,
  getRepresentativeTraceMetrics,
};
