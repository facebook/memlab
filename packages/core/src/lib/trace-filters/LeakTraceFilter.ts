/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {LeakTracePathItem} from '../Types';
import type {LeakTraceFilterOptions} from './BaseTraceFilter.rule';
import {TraceDecision} from './BaseTraceFilter.rule';
import rules from './TraceFilterRuleList';

/**
 * apply the leak trace filter rules chain and decide
 * if a leak trace is useful for memory debugging,
 * by default all leak traces are considered useful
 */
export class LeakTraceFilter {
  public filter(
    p: LeakTracePathItem,
    options: LeakTraceFilterOptions,
  ): boolean {
    for (const rule of rules) {
      const decision = rule.filter(p, options);
      if (decision === TraceDecision.INSIGHTFUL) {
        return true;
      }
      if (decision === TraceDecision.NOT_INSIGHTFUL) {
        return false;
      }
    }
    return true;
  }
}
