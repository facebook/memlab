/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {LeakTracePathItem, Optional} from '../../Types';

import config from '../../Config';
import utils from '../../Utils';

import {
  ILeakTraceFilterRule,
  LeakTraceFilterOptions,
  TraceDecision,
} from '../BaseTraceFilter.rule';

export class FilterAttachedDOMToDetachedDOMTraceRule
  implements ILeakTraceFilterRule
{
  filter(
    p: LeakTracePathItem,
    options: LeakTraceFilterOptions = {},
  ): TraceDecision {
    const curConfig = options.config ?? config;

    // if the path consists of only DOM native nodes/elements
    if (curConfig.hideBrowserLeak && isAttachedDOMToDetachedDOMChain(p)) {
      return TraceDecision.NOT_INSIGHTFUL;
    }
    return TraceDecision.MAYBE_INSIGHTFUL;
  }
}

// check if the path has pattern:
// [Attached Element] -> [InternalNode | Text]+ -> [Detached Element]
function isAttachedDOMToDetachedDOMChain(path: LeakTracePathItem): boolean {
  if (!path) {
    return false;
  }
  let p: Optional<LeakTracePathItem> = path;

  let hasEncounteredAttachedNode = false;
  // skip the rest InternalNode
  while (p != null && p.node) {
    if (utils.isDetachedDOMNode(p.node)) {
      return hasEncounteredAttachedNode;
    }
    // else if this is an attached node
    if (utils.isDOMNodeIncomplete(p.node)) {
      hasEncounteredAttachedNode = true;
    } else {
      // else if this not a DOM element
      hasEncounteredAttachedNode = false;
    }
    p = p.next;
  }
  return false;
}
