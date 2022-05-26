/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {CLIOptions, Optional} from '@memlab/core';

import BaseCommand from '../BaseCommand';
import {fileManager, config, BaseOption} from '@memlab/core';
import SetWorkingDirectoryOption from '../options/SetWorkingDirectoryOption';

export default class ResetDirectoryCommand extends BaseCommand {
  getCommandName(): string {
    return 'reset';
  }

  getDescription(): string {
    return 'reset and initialize all directories';
  }

  getOptions(): BaseOption[] {
    return [new SetWorkingDirectoryOption()];
  }

  async run(options: CLIOptions): Promise<void> {
    const workDir = options.configFromOptions?.workDir as Optional<string>;
    fileManager.rmWorkDir({workDir});
    fileManager.initDirs(config, {workDir});
  }
}
