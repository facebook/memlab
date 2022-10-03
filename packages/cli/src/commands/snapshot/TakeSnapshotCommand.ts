/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import type {CLIOptions} from '@memlab/core';

import BaseCommand from '../../BaseCommand';
import {runPageInteractionFromCLI} from './Snapshot';
import CleanRunDataCommand from '../CleanRunDataCommand';
import {BaseOption} from '@memlab/core';
import FullExecutionOption from '../../options/e2e/FullExecutionOption';
import AppOption from '../../options/e2e/AppOption';
import InteractionOption from '../../options/e2e/InteractionOption';
import SkipSnapshotOption from '../../options/e2e/SkipSnapshotOption';
import SkipScreenshotOption from '../../options/e2e/SkipScreenshotOption';
import SkipGCOption from '../../options/e2e/SkipGCOption';
import SkipScrollOption from '../../options/e2e/SkipScrollOption';
import SkipExtraOperationOption from '../../options/e2e/SkipExtraOperationOption';
import RunningModeOption from '../../options/e2e/RunningModeOption';
import RemoteBrowserDebugOption from '../../options/e2e/RemoteBrowserDebugOption';
import ScenarioFileOption from '../../options/e2e/ScenarioFileOption';
import SetDeviceOption from '../../options/e2e/SetDeviceOption';
import DisableXvfbOption from '../../options/e2e/DisableXvfbOption';
import InitDirectoryCommand from '../InitDirectoryCommand';
import CheckXvfbSupportCommand from './CheckXvfbSupportCommand';
import HeadfulBrowserOption from '../../options/e2e/HeadfulBrowserOption';
import SetUserAgentOption from '../../options/e2e/SetUserAgentOption';
import DisableWebSecurityOption from '../../options/e2e/DisableWebSecurityOption';
import EnableJSRewriteOption from '../../options/e2e/EnableJSRewriteOption';

export default class TakeSnapshotCommand extends BaseCommand {
  getCommandName(): string {
    return 'snapshot';
  }

  getDescription(): string {
    return 'interact with web app and take heap snapshots';
  }

  getPrerequisites(): BaseCommand[] {
    return [
      new InitDirectoryCommand(),
      new CleanRunDataCommand(),
      new CheckXvfbSupportCommand(),
    ];
  }

  getExamples(): string[] {
    return [
      '--scenario <TEST_SCENARIO_FILE>',
      '--scenario /tmp/test-scenario.js',
      '--scenario /tmp/test-scenario.js --work-dir /tmp/test-1/',
    ];
  }

  getOptions(): BaseOption[] {
    return [
      new HeadfulBrowserOption(),
      new AppOption(),
      new InteractionOption(),
      new FullExecutionOption(),
      new SkipSnapshotOption(),
      new SkipScreenshotOption(),
      new SkipGCOption(),
      new SkipScrollOption(),
      new SkipExtraOperationOption(),
      new RunningModeOption(),
      new RemoteBrowserDebugOption(),
      new ScenarioFileOption(),
      new SetDeviceOption(),
      new SetUserAgentOption(),
      new DisableXvfbOption(),
      new DisableWebSecurityOption(),
      new EnableJSRewriteOption(),
    ];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(_options: CLIOptions): Promise<void> {
    await runPageInteractionFromCLI();
  }
}
