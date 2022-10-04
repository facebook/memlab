/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

// features shared with MemLab UI
// NOTE: This file includes the leak trace clustering logic for MemLab Core.
//       This file will also be compiled and shared with MemLab UI, which
//       uses the clustering logic in front-end page
// So please do not add non-type dependency to this file.
// In this file, please also avoid using class definition, which needs
// additional babel plugin to transform class syntax.
import type {AnyValue, LeakTraceElement, LeakTrace} from '../lib/Types';

function NON_NULLABLE<T>(v: T | null | undefined): T {
  if (v == null) {
    throw new Error('value must not be null or undefined');
  }
  return v;
}

type NameWeightMapType = Map<string | RegExp | number, number>;
// Set this flag to true when debugging the leak trace clustering algorithm
// to get more runtime information in terminal.
const DEBUG = false;

interface ClusteringHeuristic {
  edgeNameStopWords: NameWeightMapType;
  nodeNameStopWords: NameWeightMapType;
  similarWordRegExps: Map<RegExp, number>;
  decendentDecayFactors: {kind: string; name: string; decay: number}[];
  startingModuleForTraceMatching: (string | RegExp)[];
}

export function debugLog(...args: AnyValue[]): void {
  if (!DEBUG) {
    return;
  }
  if (typeof console === 'undefined' || typeof console.log !== 'function') {
    return;
  }
  console.log(args.join(' |\t'));
}

interface DebugElementSimilarityStatsParams {
  elementA: LeakTraceElement;
  elementB: LeakTraceElement;
  matchedSum: number;
  totalSum: number;
}

export const debugTraceElementSimilarityStats = ({
  elementA,
  elementB,
  matchedSum,
  totalSum,
}: DebugElementSimilarityStatsParams): void => {
  const similarityScoreString = `${matchedSum} / ${totalSum}`;
  if (elementA.kind === 'edge') {
    debugLog(
      elementA.kind,
      elementA.name_or_index,
      elementB.name_or_index,
      similarityScoreString,
    );
    return;
  }

  debugLog(elementA.kind, elementA.name, elementB.name, similarityScoreString);
};

const SIMILAR_TRACE_THRESHOLD = 0.8;
const REACT_FIBER_EDGE_PREFIX = '__reactFiber$';
const WINDOW_NODE_PREFIX = 'Window / ';

type ClusteringUtilReturnType = {
  isSimilarTrace: (t1: LeakTrace, t2: LeakTrace) => boolean;
};

const initialize = (
  heuristics: ClusteringHeuristic,
): ClusteringUtilReturnType => {
  const {
    edgeNameStopWords,
    nodeNameStopWords,
    similarWordRegExps,
    decendentDecayFactors,
    startingModuleForTraceMatching,
  } = heuristics;

  function _searchForEdge(
    t: LeakTrace,
    name: string | number | RegExp,
  ): number {
    for (let i = 0; i < t.length; ++i) {
      const traceElement = t[i];
      if (traceElement.kind === 'edge' && 'name_or_index' in traceElement) {
        if (name instanceof RegExp) {
          if (name.test(`${traceElement.name_or_index}`)) {
            return i;
          }
        } else if (traceElement.name_or_index === name) {
          return i;
        }
      }
    }
    return -1;
  }

  function _searchForNode(t: LeakTrace, name: string | RegExp): number {
    for (let i = 0; i < t.length; ++i) {
      const traceElement = t[i];
      if (traceElement.kind === 'node' && 'name' in traceElement) {
        if (name instanceof RegExp) {
          if (name.test(NON_NULLABLE(traceElement.name))) {
            return i;
          }
        } else if (traceElement.name === name) {
          return i;
        }
      }
    }
    return -1;
  }

  function _searchForMatch(
    t1: LeakTrace,
    t2: LeakTrace,
    name: string | RegExp,
  ): [number, number] | null {
    let i1 = _searchForEdge(t1, name);
    let i2 = _searchForEdge(t2, name);
    if (i1 >= 0 && i2 >= 0) {
      return [i1, i2];
    }

    i1 = _searchForNode(t1, name);
    i2 = _searchForNode(t2, name);
    if (i1 >= 0 && i2 >= 0) {
      return [i1, i2];
    }

    return null;
  }

  // the trace similarity calculation starts from modulesMap if
  // both traces have the modulesMap heap object
  function matchTraceStartItem(t1: LeakTrace, t2: LeakTrace): [number, number] {
    for (const name of startingModuleForTraceMatching) {
      const ret = _searchForMatch(t1, t2, name);
      if (ret) {
        return ret;
      }
    }
    return [0, 0];
  }

  function getNodeStopWordWeight(name: string): number {
    return _getStopWordWeight(nodeNameStopWords, name);
  }

  function getEdgeStopWordWeight(name: string | number): number {
    return _getStopWordWeight(edgeNameStopWords, name);
  }

  function _getStopWordWeight(
    stopWordsMap: NameWeightMapType,
    name: string | number,
  ): number {
    if (stopWordsMap.has(name)) {
      return NON_NULLABLE(stopWordsMap.get(name));
    }
    for (const stopWord of stopWordsMap.keys()) {
      if (!(stopWord instanceof RegExp)) {
        continue;
      }
      if (stopWord.test(`${name}`)) {
        return NON_NULLABLE(stopWordsMap.get(stopWord));
      }
    }
    return 1;
  }

  function getSimilarWordsWeight(
    name1: string | number,
    name2: string | number,
  ): number {
    const n1 = `${name1}`;
    const n2 = `${name2}`;
    for (const regexp of similarWordRegExps.keys()) {
      if (regexp.test(n1) && regexp.test(n2)) {
        return NON_NULLABLE(similarWordRegExps.get(regexp));
      }
    }
    return 1;
  }

  function getDecendentDecayFactor(
    elem: LeakTraceElement,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _elem2: LeakTraceElement,
  ): number {
    for (const factors of decendentDecayFactors) {
      if (factors.kind === elem.kind) {
        if ('name' in elem && factors.name === elem.name) {
          return factors.decay;
        }
        if ('name_or_index' in elem && factors.name === elem.name_or_index) {
          return factors.decay;
        }
      }
    }
    return 1;
  }

  function isNodeNameSame(name1: string, name2: string): boolean {
    const isWindowNode1 =
      typeof name1 === 'string' && name1.startsWith(WINDOW_NODE_PREFIX);
    const isWindowNode2 =
      typeof name2 === 'string' && name2.startsWith(WINDOW_NODE_PREFIX);
    if (isWindowNode1 && isWindowNode2) {
      return true;
    }

    return name1 === name2;
  }

  function isNameSimilar(
    name1: string | number,
    name2: string | number,
  ): boolean {
    const n1 = `${name1}`;
    const n2 = `${name2}`;
    for (const regexp of similarWordRegExps.keys()) {
      if (regexp.test(n1) && regexp.test(n2)) {
        return true;
      }
    }
    return false;
  }

  function isEdgeNameSame(
    name1: string | number,
    name2: string | number,
  ): boolean {
    const isFiberEdge1 =
      typeof name1 === 'string' && name1.startsWith(REACT_FIBER_EDGE_PREFIX);
    const isFiberEdge2 =
      typeof name2 === 'string' && name2.startsWith(REACT_FIBER_EDGE_PREFIX);
    if (isFiberEdge1 && isFiberEdge2) {
      return true;
    }

    return name1 === name2;
  }

  function representsNumber(value: AnyValue): boolean {
    if (typeof value === 'number') {
      return true;
    }
    if (parseInt(value, 10) + '' === value + '') {
      return true;
    }
    if (parseFloat(value) + '' === value + '') {
      return true;
    }
    return false;
  }

  function areBothNodes(elem1: LeakTraceElement, elem2: LeakTraceElement) {
    if (elem1 == null || elem2 == null) {
      return false;
    }
    if (elem1.kind !== 'node' || elem2.kind !== 'node') {
      return false;
    }
    if (elem1.type !== elem2.type) {
      return false;
    }
    return true;
  }

  function isSameNode(
    elem1: LeakTraceElement,
    elem2: LeakTraceElement,
  ): boolean {
    if (!areBothNodes(elem1, elem2)) {
      return false;
    }
    return isNodeNameSame(NON_NULLABLE(elem1.name), NON_NULLABLE(elem2.name));
  }

  function isSimilarNode(
    elem1: LeakTraceElement,
    elem2: LeakTraceElement,
  ): boolean {
    if (!areBothNodes(elem1, elem2)) {
      return false;
    }
    return isNameSimilar(NON_NULLABLE(elem1.name), NON_NULLABLE(elem2.name));
  }

  function isSameEdge(
    trace1: LeakTrace,
    i1: number,
    trace2: LeakTrace,
    i2: number,
  ): boolean {
    const elem1 = trace1[i1];
    const elem2 = trace2[i2];

    if (elem1 == null || elem2 == null) {
      return false;
    }

    if (elem1.kind !== 'edge' || elem2.kind !== 'edge') {
      return false;
    }
    if (elem1.type !== elem2.type) {
      return false;
    }
    // index properties are considered the same if
    // their referrer node are the same
    if (
      representsNumber(elem1.name_or_index) &&
      representsNumber(elem2.name_or_index)
    ) {
      const referrer1 = trace1[i1 - 1];
      const referrer2 = trace2[i2 - 1];
      return isSameNode(referrer1, referrer2);
    }
    return isEdgeNameSame(
      NON_NULLABLE(elem1.name_or_index),
      NON_NULLABLE(elem2.name_or_index),
    );
  }

  function areBothEdges(elem1: LeakTraceElement, elem2: LeakTraceElement) {
    if (elem1 == null || elem2 == null) {
      return false;
    }
    if (elem1.kind !== 'edge' || elem2.kind !== 'edge') {
      return false;
    }
    if (elem1.type !== elem2.type) {
      return false;
    }
    return true;
  }

  function isSimilarEdge(
    trace1: LeakTrace,
    i1: number,
    trace2: LeakTrace,
    i2: number,
  ): boolean {
    const elem1 = trace1[i1];
    const elem2 = trace2[i2];

    if (!areBothEdges(elem1, elem2)) {
      return false;
    }
    // index properties are considered the same if
    // their referrer node are the same
    if (
      representsNumber(elem1.name_or_index) &&
      representsNumber(elem2.name_or_index)
    ) {
      const referrer1 = trace1[i1 - 1];
      const referrer2 = trace2[i2 - 1];
      return (
        isSameNode(referrer1, referrer2) || isSimilarNode(referrer1, referrer2)
      );
    }
    return isNameSimilar(
      NON_NULLABLE(elem1.name_or_index),
      NON_NULLABLE(elem2.name_or_index),
    );
  }

  function isSameOrSimilarElement(
    trace1: LeakTrace,
    i1: number,
    trace2: LeakTrace,
    i2: number,
  ): boolean {
    const elem1 = trace1[i1];
    const elem2 = trace2[i2];
    if (!elem1 || !elem2) {
      return false;
    }
    if (elem1.kind !== elem2.kind) {
      return false;
    }
    if (elem1.kind === 'edge') {
      if (isSameEdge(trace1, i1, trace2, i2)) {
        return true;
      }
      return isSimilarEdge(trace1, i1, trace2, i2);
    }
    if (isSameNode(elem1, elem2)) {
      return true;
    }
    return isSimilarNode(elem1, elem2);
  }

  function getDecayFactor(
    trace1: LeakTrace,
    i1: number,
    trace2: LeakTrace,
    i2: number,
  ): number {
    const elem1 = trace1[i1];
    const elem2 = trace2[i2];
    if (!elem1 || !elem2) {
      return 1;
    }
    if (elem1.kind !== elem2.kind) {
      return 1;
    }
    return getDecendentDecayFactor(elem1, elem2);
  }

  function getElementPairWeight(
    trace1: LeakTrace,
    i1: number,
    trace2: LeakTrace,
    i2: number,
  ): number {
    const elem1 = trace1[i1];
    const elem2 = trace2[i2];
    if (!elem1 || !elem2) {
      return 1;
    }
    if (elem1.kind !== elem2.kind) {
      return 1;
    }
    if (elem1.kind === 'edge') {
      if (!isSameEdge(trace1, i1, trace2, i2)) {
        return getSimilarWordsWeight(
          NON_NULLABLE(elem1.name_or_index),
          NON_NULLABLE(elem2.name_or_index),
        );
      }
      const edgeName = NON_NULLABLE(elem1.name_or_index);
      return getEdgeStopWordWeight(edgeName);
    }

    if (!isSameNode(elem1, elem2)) {
      return getSimilarWordsWeight(
        NON_NULLABLE(elem1.name),
        NON_NULLABLE(elem2.name),
      );
    }
    const nodeName = NON_NULLABLE(elem1.name);
    return getNodeStopWordWeight(nodeName);
  }

  function getSimilarityByTraceElementList(
    t1: LeakTrace,
    t2: LeakTrace,
  ): number {
    // find first starting item that matches
    let [i1, i2] = matchTraceStartItem(t1, t2);

    const l1 = t1.length;
    const l2 = t2.length;
    const d1 = l1 - i1;
    const d2 = l2 - i2;

    let delta1 = 0.9 / d1;
    let delta2 = 0.9 / d2;

    let w1 = 1;
    let w2 = 1;
    const l = Math.max(l1, l2);
    let matchedSum = 0;
    let totalSum = 0;

    while (i1 < l || i2 < l) {
      const trace1 = t1;
      const trace2 = t2;
      const pw = getElementPairWeight(trace1, i1, trace2, i2);
      if (isSameOrSimilarElement(trace1, i1, trace2, i2)) {
        debugTraceElementSimilarityStats({
          elementA: trace1[i1],
          elementB: trace2[i2],
          matchedSum,
          totalSum,
        });

        matchedSum += (w1 + w2) * pw;
      }
      totalSum += (w1 + w2) * pw;

      const decayFactor = 0.99 * getDecayFactor(trace1, i1, trace2, i2);
      w1 *= decayFactor;
      w2 *= decayFactor;
      delta1 *= decayFactor;
      delta2 *= decayFactor;

      if (w1 - delta1 >= 0) {
        w1 -= delta1;
      }
      if (w2 - delta2 >= 0) {
        w2 -= delta2;
      }
      ++i1;
      ++i2;
      if (i1 >= l1 || i2 >= l2) {
        const sim = matchedSum / (totalSum + 0.0001);
        if (sim > 0.9) {
          return sim;
        }
      }
    }
    return matchedSum / (totalSum + 0.0001);
  }

  function isSimilarTrace(t1: LeakTrace, t2: LeakTrace): boolean {
    const similarity = getSimilarityByTraceElementList(t1, t2);
    debugLog(similarity);
    return similarity >= SIMILAR_TRACE_THRESHOLD;
  }

  return {
    isSimilarTrace,
  };
};

export default {
  initialize,
};
