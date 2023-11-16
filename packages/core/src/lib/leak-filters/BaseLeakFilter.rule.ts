/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
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
  beforeFiltering(
    config: MemLabConfig,
    snapshot: IHeapSnapshot,
    leakedNodeIds: HeapNodeIdSet,
  ): void;

  filter(
    config: MemLabConfig,
    node: IHeapNode,
    snapshot: IHeapSnapshot,
    leakedNodeIds: HeapNodeIdSet,
  ): LeakDecision;
}

export abstract class LeakObjectFilterRuleBase
  implements ILeakObjectFilterRule
{
  beforeFiltering(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _config: MemLabConfig,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _snapshot: IHeapSnapshot,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _leakedNodeIds: HeapNodeIdSet,
  ): void {
    // do nothing by default
  }

  abstract filter(
    config: MemLabConfig,
    node: IHeapNode,
    snapshot: IHeapSnapshot,
    leakedNodeIds: HeapNodeIdSet,
  ): LeakDecision;
}
