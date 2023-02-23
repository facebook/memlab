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

export class FilterInternalNodeTraceRule implements ILeakTraceFilterRule {
  filter(
    p: LeakTracePathItem,
    options: LeakTraceFilterOptions = {},
  ): TraceDecision {
    const curConfig = options.config ?? config;

    // if the path has pattern: Window -> [InternalNode]+ -> DetachedElement
    if (curConfig.hideBrowserLeak && internalNodeRetainsDetachedElement(p)) {
      return TraceDecision.NOT_INSIGHTFUL;
    }
    return TraceDecision.MAYBE_INSIGHTFUL;
  }
}

// check if the path has pattern:
// Window -> [InternalNode | Text]+ -> DetachedElement
function internalNodeRetainsDetachedElement(path: LeakTracePathItem): boolean {
  if (!path) {
    return false;
  }
  let p: Optional<LeakTracePathItem> = path;
  // GC root is not Window
  if (!p.node || !p.node.name.startsWith('Window')) {
    return false;
  }
  p = p.next;
  // Window is not poining to InternalNode
  if (!p || !p.node || p.node.name !== 'InternalNode') {
    return false;
  }
  // skip the rest InternalNode
  while (p.node?.name === 'InternalNode' || p.node?.name === 'Text') {
    p = p.next;
    if (!p) {
      return false;
    }
  }
  // check if the node is a detached element
  return p && utils.isDetachedDOMNode(p.node);
}
