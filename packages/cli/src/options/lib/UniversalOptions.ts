/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import DebugOption from '../DebugOption';
import HelperOption from '../HelperOption';
import SetContinuousTestOption from '../SetContinuousTestOption';
import SilentOption from '../SilentOption';
import VerboseOption from '../VerboseOption';

const universalOptions = [
  new HelperOption(),
  new VerboseOption(),
  new SetContinuousTestOption(),
  new DebugOption(),
  new SilentOption(),
];

export default universalOptions;
