/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {CLIOptions} from '@memlab/core';

import BaseCommand from '../BaseCommand';
import InitDirectoryCommand from './InitDirectoryCommand';
import WarmupAppCommand from './WarmupAppCommand';
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

  getOptions(): BaseOption[] {
    return [
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
