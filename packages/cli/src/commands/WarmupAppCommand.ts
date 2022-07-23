/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {CLIOptions} from '@memlab/core';

import {BaseOption} from '@memlab/core';
import BaseCommand from '../BaseCommand';
import {warmup} from '@memlab/api';
import InitDirectoryCommand from './InitDirectoryCommand';
import AppOption from '../options/AppOption';
import InteractionOption from '../options/InteractionOption';
import RunningModeOption from '../options/RunningModeOption';
import RemoteBrowserDebugOption from '../options/RemoteBrowserDebugOption';
import ScenarioFileOption from '../options/ScenarioFileOption';
import SetDeviceOption from '../options/SetDeviceOption';
import DisableXvfbOption from '../options/DisableXvfbOption';
import SkipWarmupOption from '../options/SkipWarmupOption';
import CheckXvfbSupportCommand from './snapshot/CheckXvfbSupportCommand';
import HeadfulBrowserOption from '../options/HeadfulBrowserOption';

export default class FBWarmupAppCommand extends BaseCommand {
  getCommandName(): string {
    return 'warmup';
  }

  getDescription(): string {
    return 'warm up the target app';
  }

  getPrerequisites(): BaseCommand[] {
    return [new InitDirectoryCommand(), new CheckXvfbSupportCommand()];
  }

  getExamples(): string[] {
    return [
      '--scenario <TEST_SCENARIO_FILE>',
      '--scenario /tmp/test-scenario.js',
    ];
  }

  getOptions(): BaseOption[] {
    return [
      new HeadfulBrowserOption(),
      new AppOption(),
      new InteractionOption(),
      new RunningModeOption(),
      new RemoteBrowserDebugOption(),
      new ScenarioFileOption(),
      new SetDeviceOption(),
      new DisableXvfbOption(),
      new SkipWarmupOption(),
    ];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(_options: CLIOptions): Promise<void> {
    await warmup();
  }
}
