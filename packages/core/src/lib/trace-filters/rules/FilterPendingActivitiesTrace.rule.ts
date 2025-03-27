/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {LeakTracePathItem, Optional} from '../../Types';

import config from '../../Config';
import utils from '../../Utils';

import {
  ILeakTraceFilterRule,
  LeakTraceFilterOptions,
  TraceDecision,
} from '../BaseTraceFilter.rule';

export class FilterPendingActivitiesTraceRule implements ILeakTraceFilterRule {
  filter(
    p: LeakTracePathItem,
    options: LeakTraceFilterOptions = {},
  ): TraceDecision {
    const curConfig = options.config ?? config;

    // if the path has pattern: Pending activitiies -> DetachedElement
    if (
      curConfig.hideBrowserLeak &&
      pendingActivitiesRetainsDetachedElementChain(p)
    ) {
      return TraceDecision.NOT_INSIGHTFUL;
    }
    return TraceDecision.MAYBE_INSIGHTFUL;
  }
}

function pendingActivitiesRetainsDetachedElementChain(
  path: LeakTracePathItem,
): boolean {
  let p: Optional<LeakTracePathItem> = path;
  // find the Pending activities
  while (p && p.node && !utils.isPendingActivityNode(p.node)) {
    p = p.next;
    if (!p) {
      return false;
    }
  }
  p = p.next;
  if (!p || !p.node) {
    return false;
  }
  // Scan the rest of the trace, if the following check is met,
  // the leak trace is considered as not suitable for debugging:
  // If the scanner encounters an object o on the
  // rest of the leak trace, where o is neither a detached DOM node nor a
  // Fiber Node and if the scanner didn't hit a detached DOM node first
  while (p && p.node) {
    if (utils.isDetachedDOMNode(p.node)) {
      return true;
    }
    if (
      !utils.isDOMInternalNode(p.node) &&
      !utils.isDetachedDOMNode(p.node) &&
      !utils.isFiberNode(p.node)
    ) {
      return false;
    }
    p = p.next;
  }
  return true;
}
