/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {CLIOptions, Optional} from '@memlab/core';

import BaseCommand from '../BaseCommand';
import {fileManager, BaseOption} from '@memlab/core';
import SetWorkingDirectoryOption from '../options/SetWorkingDirectoryOption';

export default class CleanRunDataCommand extends BaseCommand {
  getCommandName(): string {
    return 'clear-run-data';
  }

  getDescription(): string {
    return 'remove all web page E2E data generated from memlab runs';
  }

  isInternalCommand(): boolean {
    return true;
  }

  getOptions(): BaseOption[] {
    return [new SetWorkingDirectoryOption()];
  }

  async run(options: CLIOptions): Promise<void> {
    const workDir = options.configFromOptions?.workDir as Optional<string>;
    fileManager.clearDataDirs({workDir});
  }
}
