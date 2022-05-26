/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {CLIOptions, Optional} from '@memlab/core';

import BaseCommand from '../BaseCommand';
import {fileManager, BaseOption} from '@memlab/core';
import SetWorkingDirectoryOption from '../options/SetWorkingDirectoryOption';
import InitDirectoryCommand from './InitDirectoryCommand';

export default class CleanTraceDataCommand extends BaseCommand {
  getCommandName(): string {
    return 'clear-trace-data';
  }

  getDescription(): string {
    return 'remove all retainer trace data generated from memlab runs';
  }

  isInternalCommand(): boolean {
    return true;
  }

  getOptions(): BaseOption[] {
    return [new SetWorkingDirectoryOption()];
  }

  async run(options: CLIOptions): Promise<void> {
    const workDir = options.configFromOptions?.workDir as Optional<string>;
    fileManager.emptyTraceLogDataDir({workDir});
    await new InitDirectoryCommand().run(options);
  }
}
