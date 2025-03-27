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
import {ILeakObjectFilterRule} from './BaseLeakFilter.rule';
import {FilterByExternalFilterRule} from './rules/FilterByExternalFilter.rule';
import {FilterDetachedDOMElementRule} from './rules/FilterDetachedDOMElement.rule';
import {FilterHermesNodeRule} from './rules/FilterHermesNode.rule';
import {FilterOverSizedNodeAsLeakRule} from './rules/FilterOverSizedNodeAsLeak.rule';
import {FilterStackTraceFrameRule} from './rules/FilterStackTraceFrame.rule';
import {FilterTrivialNodeRule} from './rules/FilterTrivialNode.rule';
import {FilterUnmountedFiberNodeRule} from './rules/FilterUnmountedFiberNode.rule';
import {FilterXMLHTTPRequestRule} from './rules/FilterXMLHTTPRequest.rule';
import {FilterUserTaggedLeaksRule} from './rules/FilterUserTaggedLeaks.rule';

const list: ILeakObjectFilterRule[] = [
  new FilterUserTaggedLeaksRule(),
  new FilterByExternalFilterRule(),
  new FilterTrivialNodeRule(),
  new FilterHermesNodeRule(),
  new FilterOverSizedNodeAsLeakRule(),
  new FilterUnmountedFiberNodeRule(),
  new FilterDetachedDOMElementRule(),
  new FilterStackTraceFrameRule(),
  new FilterXMLHTTPRequestRule(),
];

export default setInternalValue(list, __filename, constant.internalDir);
