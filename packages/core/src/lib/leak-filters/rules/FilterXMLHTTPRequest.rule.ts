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
import type {IHeapEdge, IHeapNode} from '../../Types';
import {LeakDecision, LeakObjectFilterRuleBase} from '../BaseLeakFilter.rule';

/**
 * mark XMLHTTPRequest with status ok as memory leaks
 */
export class FilterXMLHTTPRequestRule extends LeakObjectFilterRuleBase {
  filter(_config: MemLabConfig, node: IHeapNode): LeakDecision {
    return this.checkFinishedXMLHTTPRequest(node)
      ? LeakDecision.LEAK
      : LeakDecision.MAYBE_LEAK;
  }

  protected checkFinishedXMLHTTPRequest(node: IHeapNode): boolean {
    if (node.name !== 'XMLHttpRequest' || node.type !== 'native') {
      return false;
    }
    return (
      node.findAnyReference(
        (edge: IHeapEdge) => edge.toNode.name === '{"status":"ok"}',
      ) != null
    );
  }
}
