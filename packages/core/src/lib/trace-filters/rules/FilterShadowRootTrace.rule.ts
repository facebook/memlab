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

export class FilterShadowRootTraceRule implements ILeakTraceFilterRule {
  filter(
    p: LeakTracePathItem,
    options: LeakTraceFilterOptions = {},
  ): TraceDecision {
    const curConfig = options.config ?? config;

    // if the path has pattern: ShadowRoot -> DetachedElement
    if (curConfig.hideBrowserLeak && shadowRootRetainsDetachedElement(p)) {
      return TraceDecision.NOT_INSIGHTFUL;
    }
    return TraceDecision.MAYBE_INSIGHTFUL;
  }
}

// check if the path has pattern: ShadowRoot -> DetachedElement
function shadowRootRetainsDetachedElement(path: LeakTracePathItem): boolean {
  let p: Optional<LeakTracePathItem> = path;
  // find the ShadowRoot
  while (p && p.node && p.node.name !== 'ShadowRoot') {
    p = p.next;
    if (!p) {
      return false;
    }
  }
  p = p.next;
  // check if the node is a detached element
  return !!p && utils.isDetachedDOMNode(p.node);
}
