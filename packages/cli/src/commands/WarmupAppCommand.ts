/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
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

  getOptions(): BaseOption[] {
    return [
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
