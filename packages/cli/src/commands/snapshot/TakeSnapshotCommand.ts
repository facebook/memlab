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

import BaseCommand from '../../BaseCommand';
import {runPageInteractionFromCLI} from './Snapshot';
import CleanRunDataCommand from '../CleanRunDataCommand';
import {BaseOption} from '@memlab/core';
import FullExecutionOption from '../../options/FullExecutionOption';
import AppOption from '../../options/AppOption';
import InteractionOption from '../../options/InteractionOption';
import SkipSnapshotOption from '../../options/SkipSnapshotOption';
import SkipScreenshotOption from '../../options/SkipScreenshotOption';
import SkipGCOption from '../../options/SkipGCOption';
import SkipScrollOption from '../../options/SkipScrollOption';
import SkipExtraOperationOption from '../../options/SkipExtraOperationOption';
import RunningModeOption from '../../options/RunningModeOption';
import RemoteBrowserDebugOption from '../../options/RemoteBrowserDebugOption';
import ScenarioFileOption from '../../options/ScenarioFileOption';
import SetDeviceOption from '../../options/SetDeviceOption';
import DisableXvfbOption from '../../options/DisableXvfbOption';
import InitDirectoryCommand from '../InitDirectoryCommand';
import CheckXvfbSupportCommand from './CheckXvfbSupportCommand';

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

  getOptions(): BaseOption[] {
    return [
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(_options: CLIOptions): Promise<void> {
    await runPageInteractionFromCLI();
  }
}
