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

import BaseCommand from '../BaseCommand';
import InitDirectoryCommand from './InitDirectoryCommand';
import {modes, config, BaseOption} from '@memlab/core';
import CleanRunDataCommand from './CleanRunDataCommand';
import {runPageInteractionFromCLI} from './snapshot/Snapshot';
import AppOption from '../options/e2e/AppOption';
import FullExecutionOption from '../options/e2e/FullExecutionOption';
import InteractionOption from '../options/e2e/InteractionOption';
import SkipScreenshotOption from '../options/e2e/SkipScreenshotOption';
import SkipSnapshotOption from '../options/e2e/SkipSnapshotOption';
import SkipGCOption from '../options/e2e/SkipGCOption';
import SkipScrollOption from '../options/e2e/SkipScrollOption';
import SkipExtraOperationOption from '../options/e2e/SkipExtraOperationOption';
import RunningModeOption from '../options/e2e/RunningModeOption';
import RemoteBrowserDebugOption from '../options/e2e/RemoteBrowserDebugOption';
import ScenarioFileOption from '../options/e2e/ScenarioFileOption';
import SetDeviceOption from '../options/e2e/SetDeviceOption';
import SetUserAgentOption from '../options/e2e/SetUserAgentOption';
import DisableXvfbOption from '../options/e2e/DisableXvfbOption';
import NumberOfRunsOption from '../options/NumberOfRunsOption';
import HeadfulBrowserOption from '../options/e2e/HeadfulBrowserOption';
import DisableWebSecurityOption from '../options/e2e/DisableWebSecurityOption';
import EnableJSRewriteOption from '../options/e2e/EnableJSRewriteOption';

export default class RunMeasureCommand extends BaseCommand {
  getCommandName(): string {
    return 'measure';
  }

  getDescription(): string {
    return 'Run test scenario in measure mode';
  }

  getPrerequisites(): BaseCommand[] {
    return [new CleanRunDataCommand(), new InitDirectoryCommand()];
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
      new NumberOfRunsOption(),
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

  async run(options: CLIOptions): Promise<void> {
    const numRuns =
      options.configFromOptions?.numOfRuns ??
      NumberOfRunsOption.DEFAULT_NUM_RUNS;
    config.runningMode = modes.get('measure', config);
    for (let i = 0; i < numRuns; ++i) {
      await runPageInteractionFromCLI();
    }
  }
}
