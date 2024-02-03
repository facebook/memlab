/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import {MemLabConfig, Nullable, Optional, utils} from '@memlab/core';
import type {RunOptions} from '../API';

/**
 * enum of all console mode options
 */
export enum ConsoleMode {
  /**
   * mute all terminal output, equivalent to using `--silent`
   */
  SILENT = 'SILENT',
  /**
   * continuous test mode, no terminal output overwrite or animation,
   * equivalent to using `--sc`
   */
  CONTINUOUS_TEST = 'CONTINUOUS_TEST',
  /**
   * the default mode, there could be terminal output overwrite and animation,
   */
  DEFAULT = 'DEFAULT',
  /**
   * verbose mode, there could be terminal output overwrite and animation
   */
  VERBOSE = 'VERBOSE',
}

/**
 * Manage, save, and restore the current state of the Console modes.
 * @internal
 */
class ConsoleModeManager {
  getAndUpdateState(config: MemLabConfig, options: RunOptions = {}) {
    return this.setConsoleMode(config, options.consoleMode, true);
  }

  restoreState(config: MemLabConfig, modes: Nullable<Set<ConsoleMode>>) {
    if (modes == null) {
      return;
    }
    this.resetConsoleMode(config);
    for (const mode of modes) {
      this.setConsoleMode(config, mode, false);
    }
  }

  private resetConsoleMode(config: MemLabConfig): void {
    config.muteConsole = false;
    config.isContinuousTest = false;
    config.verbose = false;
  }

  private setConsoleMode(
    config: MemLabConfig,
    mode: Optional<ConsoleMode>,
    reset: boolean,
  ): Nullable<Set<ConsoleMode>> {
    let existingModes: Nullable<Set<ConsoleMode>> =
      this.getExistingConsoleModes(config);
    switch (mode) {
      case ConsoleMode.SILENT:
        reset && this.resetConsoleMode(config);
        config.muteConsole = true;
        break;
      case ConsoleMode.CONTINUOUS_TEST:
        reset && this.resetConsoleMode(config);
        config.isContinuousTest = true;
        break;
      case ConsoleMode.DEFAULT:
        reset && this.resetConsoleMode(config);
        config.muteConsole = false;
        config.isContinuousTest = false;
        break;
      case ConsoleMode.VERBOSE:
        reset && this.resetConsoleMode(config);
        config.verbose = true;
        break;
      default:
        if (mode == null) {
          existingModes = null;
        } else {
          throw utils.haltOrThrow(`Unknown console mode: ${mode}`);
        }
    }
    return existingModes;
  }

  private getExistingConsoleModes(config: MemLabConfig): Set<ConsoleMode> {
    const modes = new Set<ConsoleMode>([ConsoleMode.DEFAULT]);
    if (config.muteConsole) {
      modes.add(ConsoleMode.SILENT);
      modes.delete(ConsoleMode.DEFAULT);
    }
    if (config.isContinuousTest) {
      modes.add(ConsoleMode.CONTINUOUS_TEST);
      modes.delete(ConsoleMode.DEFAULT);
    }
    if (config.verbose) {
      modes.add(ConsoleMode.VERBOSE);
    }
    return modes;
  }
}

/** @internal */
export default new ConsoleModeManager();
