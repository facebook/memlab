/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {MemLabConfig} from '../../Config';
import type {IHeapNode} from '../../Types';
import {ILeakObjectFilterRule, LeakDecision} from '../BaseLeakFilter.rule';
import utils from '../../Utils';

/**
 * mark detached DOM elements as memory leaks
 */
export class FilterDetachedDOMElementRule implements ILeakObjectFilterRule {
  filter(_config: MemLabConfig, node: IHeapNode): LeakDecision {
    const isDetached = utils.isDetachedDOMNode(node, {
      ignoreInternalNode: true,
    });
    if (isDetached) {
      return LeakDecision.LEAK;
    }
    return LeakDecision.MAYBE_LEAK;
  }

  protected checkDetachedFiberNode(
    config: MemLabConfig,
    node: IHeapNode,
  ): boolean {
    if (
      !config.detectFiberNodeLeak ||
      !utils.isFiberNode(node) ||
      utils.hasHostRoot(node)
    ) {
      return false;
    }
    return !utils.isNodeDominatedByDeletionsArray(node);
  }
}
