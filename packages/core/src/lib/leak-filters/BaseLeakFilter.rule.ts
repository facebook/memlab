/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {MemLabConfig} from '../Config';
import type {HeapNodeIdSet, IHeapNode, IHeapSnapshot} from '../Types';

/**
 * Every leak object filter rule needs to give a label
 * to each object passed to the filter
 */
export enum LeakDecision {
  LEAK = 'leak',
  MAYBE_LEAK = 'maybe-leak',
  NOT_LEAK = 'not-leak',
}

export interface ILeakObjectFilterRule {
  filter(
    config: MemLabConfig,
    node: IHeapNode,
    snapshot: IHeapSnapshot,
    leakedNodeIds: HeapNodeIdSet,
  ): LeakDecision;
}
