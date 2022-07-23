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

import BaseCommand from '../BaseCommand';
import InitDirectoryCommand from './InitDirectoryCommand';
import {modes, config, BaseOption} from '@memlab/core';
import CleanRunDataCommand from './CleanRunDataCommand';
import {runPageInteractionFromCLI} from './snapshot/Snapshot';
import AppOption from '../options/AppOption';
import FullExecutionOption from '../options/FullExecutionOption';
import InteractionOption from '../options/InteractionOption';
import SkipScreenshotOption from '../options/SkipScreenshotOption';
import SkipSnapshotOption from '../options/SkipSnapshotOption';
import SkipGCOption from '../options/SkipGCOption';
import SkipScrollOption from '../options/SkipScrollOption';
import SkipExtraOperationOption from '../options/SkipExtraOperationOption';
import RunningModeOption from '../options/RunningModeOption';
import RemoteBrowserDebugOption from '../options/RemoteBrowserDebugOption';
import ScenarioFileOption from '../options/ScenarioFileOption';
import SetDeviceOption from '../options/SetDeviceOption';
import DisableXvfbOption from '../options/DisableXvfbOption';
import NumberOfRunsOption from '../options/NumberOfRunsOption';
import HeadfulBrowserOption from '../options/HeadfulBrowserOption';

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
      new DisableXvfbOption(),
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
