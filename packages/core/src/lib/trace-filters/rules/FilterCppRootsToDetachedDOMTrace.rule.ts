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

export class FilterCppRootsToDetachedDOMTraceRule
  implements ILeakTraceFilterRule
{
  filter(
    p: LeakTracePathItem,
    options: LeakTraceFilterOptions = {},
  ): TraceDecision {
    const curConfig = options.config ?? config;

    // if the path contains edges from [C++ roots] to detached DOM elements
    if (curConfig.hideBrowserLeak && hasCppRootsToDetachedDOMNode(p)) {
      return TraceDecision.NOT_INSIGHTFUL;
    }
    return TraceDecision.MAYBE_INSIGHTFUL;
  }
}

function hasCppRootsToDetachedDOMNode(path: LeakTracePathItem): boolean {
  let p: Optional<LeakTracePathItem> = path;
  // all the reference chain consists of DOM elements/nodes
  while (p && p.node) {
    if (
      utils.isCppRootsNode(p.node) &&
      p.next &&
      p.next.node &&
      utils.isDOMNodeIncomplete(p.next.node)
    ) {
      return true;
    }
    p = p.next;
  }
  return false;
}
