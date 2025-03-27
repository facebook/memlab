/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import constant from '../Constant';
import {setInternalValue} from '../InternalValueSetter';
import {ILeakTraceFilterRule} from './BaseTraceFilter.rule';
import {FilterAttachedDOMToDetachedDOMTraceRule} from './rules/FilterAttachedDOMToDetachedDOMTrace.rule';
import {FilterCppRootsToDetachedDOMTraceRule} from './rules/FilterCppRootsToDetachedDOMTrace.rule';
import {FilterDOMNodeChainTraceRule} from './rules/FilterDOMNodeChainTrace.rule';
import {FilterHermesTraceRule} from './rules/FilterHermesTrace.rule';
import {FilterInternalNodeTraceRule} from './rules/FilterInternalNodeTrace.rule';
import {FilterPendingActivitiesTraceRule} from './rules/FilterPendingActivitiesTrace.rule';
import {FilterShadowRootTraceRule} from './rules/FilterShadowRootTrace.rule';
import {FilterStyleEngineTraceRule} from './rules/FilterStyleEngineTrace.rule';

const list: ILeakTraceFilterRule[] = [
  new FilterHermesTraceRule(),
  new FilterInternalNodeTraceRule(),
  new FilterShadowRootTraceRule(),
  new FilterStyleEngineTraceRule(),
  new FilterPendingActivitiesTraceRule(),
  new FilterDOMNodeChainTraceRule(),
  new FilterAttachedDOMToDetachedDOMTraceRule(),
  new FilterCppRootsToDetachedDOMTraceRule(),
];

export default setInternalValue(list, __filename, constant.internalDir);
