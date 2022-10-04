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
import utils from '../../Utils';

/**
 * stack trace frames as memory leaks
 */
export class FilterStackTraceFrameRule implements ILeakObjectFilterRule {
  filter(_config: MemLabConfig, node: IHeapNode): LeakDecision {
    return utils.isStackTraceFrame(node)
      ? LeakDecision.LEAK
      : LeakDecision.MAYBE_LEAK;
  }
}
