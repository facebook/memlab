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

import utils from '../../Utils';
import {TraceObjectMode} from '../../Config';
import {ILeakObjectFilterRule, LeakDecision} from '../BaseLeakFilter.rule';

/**
 * trivial nodes are not reported as memory leaks
 */
export class FilterOverSizedNodeAsLeakRule implements ILeakObjectFilterRule {
  filter(config: MemLabConfig, node: IHeapNode): LeakDecision {
    if (config.oversizeObjectAsLeak) {
      // TODO: add support to skip this check
      if (!isHeapNodeUsefulForLeakTraceDiffing(config, node)) {
        return LeakDecision.NOT_LEAK;
      }
      return node.retainedSize > config.oversizeThreshold
        ? LeakDecision.LEAK
        : LeakDecision.NOT_LEAK;
    }
    return LeakDecision.MAYBE_LEAK;
  }
}

function isHeapNodeUsefulForLeakTraceDiffing(
  config: MemLabConfig,
  node: IHeapNode,
): boolean {
  if (config.traceAllObjectsMode === TraceObjectMode.Default) {
    return true;
  }
  const name = node.name;
  if (node.type !== 'object') {
    return false;
  }
  if (name.startsWith('system / ')) {
    return false;
  }
  if (utils.isFiberNode(node) && !utils.isDetachedFiberNode(node)) {
    return false;
  }
  if (utils.isDOMNodeIncomplete(node) && !utils.isDetachedDOMNode(node)) {
    return false;
  }
  if (node.getAnyReferrer('__proto__') != null) {
    return false;
  }
  if (node.getAnyReferrer('prototype') != null) {
    return false;
  }
  // react internal objects
  if (node.getAnyReferrer('dependencies') != null) {
    return false;
  }
  if (node.getAnyReferrer('memoizedState') != null) {
    return false;
  }
  if (node.getAnyReferrer('next') != null) {
    return false;
  }
  if (node.getAnyReferrer('deps') != null) {
    return false;
  }
  if (node.getReference('baseQueue') != null) {
    return false;
  }
  return true;
}
