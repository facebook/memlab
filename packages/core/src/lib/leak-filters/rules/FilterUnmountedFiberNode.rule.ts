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
 * mark React FiberNodes without a React Fiber Root as memory leaks
 */
export class FilterUnmountedFiberNodeRule implements ILeakObjectFilterRule {
  filter(config: MemLabConfig, node: IHeapNode): LeakDecision {
    if (this.checkDetachedFiberNode(config, node)) {
      return LeakDecision.LEAK;
    }
    return LeakDecision.MAYBE_LEAK;
  }

  protected checkDetachedFiberNode(
    config: MemLabConfig,
    node: IHeapNode,
  ): boolean {
    if (!config.detectFiberNodeLeak || !utils.isFiberNode(node)) {
      return false;
    }
    if (!utils.isDetachedFiberNode(node)) {
      return false;
    }
    return !utils.isNodeDominatedByDeletionsArray(node);
  }
}
