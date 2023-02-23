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

export class FilterDOMNodeChainTraceRule implements ILeakTraceFilterRule {
  filter(
    p: LeakTracePathItem,
    options: LeakTraceFilterOptions = {},
  ): TraceDecision {
    const curConfig = options.config ?? config;

    // if the path consists of only DOM native nodes/elements
    if (curConfig.hideBrowserLeak && isDOMNodeChain(p)) {
      return TraceDecision.NOT_INSIGHTFUL;
    }
    return TraceDecision.MAYBE_INSIGHTFUL;
  }
}

function isDOMNodeChain(path: LeakTracePathItem): boolean {
  let p: Optional<LeakTracePathItem> = path;
  // all the reference chain consists of DOM elements/nodes
  while (p && p.node) {
    if (!utils.isRootNode(p.node) && !utils.isDOMNodeIncomplete(p.node)) {
      return false;
    }
    p = p.next;
  }
  return true;
}
