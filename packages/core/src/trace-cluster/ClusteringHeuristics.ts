/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import {setInternalValue} from '../lib/InternalValueSetter';
import Constant from '../lib/Constant';

export default setInternalValue(
  {
    edgeNameStopWords: new Map(),
    nodeNameStopWords: new Map(),
    similarWordRegExps: new Map(),
    decendentDecayFactors: [] as {kind: string; name: string; decay: number}[],
    startingModuleForTraceMatching: [] as (string | RegExp)[],
  },
  __filename,
  Constant.internalDir,
);
