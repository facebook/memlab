/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import Xvfb from 'xvfb';
import type {Nullable, XvfbType} from '@memlab/core';
import {info, config} from '@memlab/core';

export default {
  startIfEnabled(): Nullable<XvfbType> {
    const failRet = null;
    if (!config.useXVFB || !config.machineSupportsXVFB) {
      return failRet;
    }
    if (config.verbose) {
      info.lowLevel('starting xvfb...');
    }
    const xvfb = new Xvfb({
      silent: true,
      xvfb_args: ['-screen', '0', '1280x720x24', '-ac'],
      timeout: 10000, // 10 seconds timeout for Xvfb start
    });
    try {
      xvfb.startSync();
    } catch (_e) {
      if (config.verbose) {
        info.lowLevel('fail to start xvfb...');
      }
      config.disableXvfb();
      return failRet;
    }
    config.enableXvfb(xvfb.display());
    return xvfb;
  },
};
