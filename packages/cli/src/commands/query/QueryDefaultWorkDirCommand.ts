/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
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
