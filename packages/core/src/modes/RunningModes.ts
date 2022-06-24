/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {Config, IRunningMode} from '../lib/Types';

import utils from '../lib/Utils';
import BaseMode from './BaseMode';
import InteractionTestMode from './InteractionTestMode';
import MeasureMode from './MeasureMode';

export default {
  get(name: string, config?: Config): IRunningMode {
    let ret: IRunningMode;
    switch (name) {
      case 'regular':
        ret = new BaseMode();
        break;
      case 'interaction-test':
        ret = new InteractionTestMode();
        break;
      case 'measure':
        ret = new MeasureMode();
        break;
      default:
        throw utils.haltOrThrow(`unknown running mode: ${name}`);
    }
    if (config) {
      ret.setConfig(config);
    }
    return ret;
  },
};
