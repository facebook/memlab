/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {IHeapNode, IHeapSnapshot, HeapNodeIdSet, utils} from '@memlab/core';
import {initMap} from './FilterLib';

let map = Object.create(null);

const beforeLeakFilter = (
  snapshot: IHeapSnapshot,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _leakedNodeIds: HeapNodeIdSet,
): void => {
  map = initMap(snapshot);
};

// duplicated string with size > 1KB as memory leak
const leakFilter = (node: IHeapNode): boolean => {
  if (node.type !== 'string' || node.retainedSize < 1000) {
    return false;
  }
  const str = utils.getStringNodeValue(node);
  return map[str] > 1;
};

export default {beforeLeakFilter, leakFilter};
