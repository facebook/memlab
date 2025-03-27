/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {MemLabConfig} from '../../Config';
import type {IHeapNode} from '../../Types';
import {LeakDecision, LeakObjectFilterRuleBase} from '../BaseLeakFilter.rule';
import utils from '../../Utils';

/**
 * mark detached DOM elements as memory leaks
 */
export class FilterDetachedDOMElementRule extends LeakObjectFilterRuleBase {
  filter(_config: MemLabConfig, node: IHeapNode): LeakDecision {
    const isDetached = utils.isDetachedDOMNode(node, {
      ignoreInternalNode: true,
    });
    if (
      isDetached &&
      !isDominatedByEdgeName(node, 'stateNode') &&
      !isDetachedDOMNodeDominatedByDehydratedMemoizedState(node)
    ) {
      return LeakDecision.LEAK;
    }
    return LeakDecision.MAYBE_LEAK;
  }
}

function isDominatedByEdgeName(
  node: IHeapNode,
  edgeNameOrIndex: string | number,
): boolean {
  const referrerNode = node.getAnyReferrerNode(edgeNameOrIndex);
  if (referrerNode == null) {
    return false;
  }
  return referrerNode.id === node.dominatorNode?.id;
}

// check if the input is a detached DOM node dominated by a 'dehydrated'
// edge from a memoizedState. In this case, the node is not a memory leak
function isDetachedDOMNodeDominatedByDehydratedMemoizedState(
  node: IHeapNode,
): boolean {
  const referrerNode = node.getAnyReferrerNode('dehydrated', 'property');
  if (referrerNode == null) {
    return false;
  }
  return (
    referrerNode.id === node.dominatorNode?.id &&
    isDominatedByEdgeName(referrerNode, 'memoizedState')
  );
}
