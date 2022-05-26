/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 *
 * @format
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
