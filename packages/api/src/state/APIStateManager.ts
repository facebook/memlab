/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {MemLabConfig, Optional, PuppeteerConfig} from '@memlab/core';
import type {ConsoleMode} from './ConsoleModeManager';
import type {RunOptions} from '../API';

import consoleModeManager from './ConsoleModeManager';
import puppeteerConfigManager from './PuppeteerConfigManager';

export class APIState {
  modes: Optional<Set<ConsoleMode>>;
  puppeteerConfig: Optional<PuppeteerConfig>;
}

/**
 * Manage, save, and restore the current state of the API.
 */
class APIStateManager {
  getAndUpdateState(config: MemLabConfig, options: RunOptions = {}) {
    const state = new APIState();
    state.modes = consoleModeManager.getAndUpdateState(config, options);
    state.puppeteerConfig = puppeteerConfigManager.getAndUpdateState(
      config,
      options,
    );
    return state;
  }

  restoreState(config: MemLabConfig, state: APIState) {
    if (state.modes) {
      consoleModeManager.restoreState(config, state.modes);
    }
    if (state.puppeteerConfig) {
      puppeteerConfigManager.restoreState(config, state.puppeteerConfig);
    }
  }
}

export default new APIStateManager();
