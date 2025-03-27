/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {MemLabConfig, PuppeteerConfig} from '@memlab/core';
import type {RunOptions} from '../API';

import {utils} from '@memlab/core';

/**
 * Manage, save, and restore the current state of the PuppeteerConfig.
 */
class PuppeteerStateManager {
  getAndUpdateState(config: MemLabConfig, options: RunOptions = {}) {
    const existing = config.puppeteerConfig;
    config.puppeteerConfig = {...config.puppeteerConfig};
    config.externalCookiesFile = options.cookiesFile;
    config.scenario = options.scenario;
    if (options.chromiumBinary != null) {
      utils.setChromiumBinary(config, options.chromiumBinary);
    }
    return existing;
  }

  restoreState(config: MemLabConfig, puppeteerConfig: PuppeteerConfig) {
    config.puppeteerConfig = puppeteerConfig;
  }
}

export default new PuppeteerStateManager();
