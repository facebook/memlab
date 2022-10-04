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
import type {IHeapNode} from '../../Types';
import {ILeakObjectFilterRule, LeakDecision} from '../BaseLeakFilter.rule';

/**
 * trivial nodes are not reported as memory leaks
 */
export class FilterOverSizedNodeAsLeakRule implements ILeakObjectFilterRule {
  filter(config: MemLabConfig, node: IHeapNode): LeakDecision {
    if (config.oversizeObjectAsLeak) {
      return node.retainedSize > config.oversizeThreshold
        ? LeakDecision.LEAK
        : LeakDecision.NOT_LEAK;
    }
    return LeakDecision.MAYBE_LEAK;
  }
}
