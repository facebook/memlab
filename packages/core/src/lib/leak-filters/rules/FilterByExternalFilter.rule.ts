/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {MemLabConfig} from '../../Config';
import type {HeapNodeIdSet, IHeapNode, IHeapSnapshot} from '../../Types';

import {LeakDecision, LeakObjectFilterRuleBase} from '../BaseLeakFilter.rule';

/**
 * filter memory leaks defined by external leak filter
 */
export class FilterByExternalFilterRule extends LeakObjectFilterRuleBase {
  filter(
    config: MemLabConfig,
    node: IHeapNode,
    snapshot: IHeapSnapshot,
    leakedNodeIds: HeapNodeIdSet,
  ): LeakDecision {
    if (config.externalLeakFilter) {
      return config.externalLeakFilter.leakFilter(node, snapshot, leakedNodeIds)
        ? LeakDecision.LEAK
        : LeakDecision.NOT_LEAK;
    }
    return LeakDecision.MAYBE_LEAK;
  }
}
