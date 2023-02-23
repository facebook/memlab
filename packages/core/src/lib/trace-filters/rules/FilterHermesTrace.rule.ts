/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {LeakTracePathItem} from '../../Types';

import config from '../../Config';

import {
  ILeakTraceFilterRule,
  LeakTraceFilterOptions,
  TraceDecision,
} from '../BaseTraceFilter.rule';

export class FilterHermesTraceRule implements ILeakTraceFilterRule {
  filter(
    _p: LeakTracePathItem,
    options: LeakTraceFilterOptions = {},
  ): TraceDecision {
    const curConfig = options.config ?? config;
    // do not filter out paths when analyzing Hermes snapshots
    if (curConfig.jsEngine === 'hermes') {
      return TraceDecision.INSIGHTFUL;
    }
    return TraceDecision.MAYBE_INSIGHTFUL;
  }
}
