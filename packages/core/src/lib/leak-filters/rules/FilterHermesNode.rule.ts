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
import {ILeakObjectFilterRule, LeakDecision} from '../BaseLeakFilter.rule';
import utils from '../../Utils';

export class FilterHermesNodeRule implements ILeakObjectFilterRule {
  public filter(config: MemLabConfig, node: IHeapNode): LeakDecision {
    // when analyzing hermes heap snapshots, filter Hermes internal objects
    if (config.jsEngine === 'hermes' && utils.isHermesInternalObject(node)) {
      return LeakDecision.NOT_LEAK;
    }
    return LeakDecision.MAYBE_LEAK;
  }
}
