/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import {CLIOptions, info} from '@memlab/core';

import BaseCommand, {CommandCategory} from '../../BaseCommand';
import {fileManager, BaseOption} from '@memlab/core';

export default class QueryDefaultWorkDirCommand extends BaseCommand {
  getCommandName(): string {
    return 'get-default-work-dir';
  }

  getDescription(): string {
    return 'query the default working directory';
  }

  getCategory(): CommandCategory {
    return CommandCategory.MISC;
  }

  getOptions(): BaseOption[] {
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(_options: CLIOptions): Promise<void> {
    info.topLevel(fileManager.getWorkDir());
  }
}
