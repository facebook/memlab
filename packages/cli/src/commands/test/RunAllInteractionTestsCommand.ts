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

import BaseCommand, {CommandCategory} from '../../BaseCommand';
import InitDirectoryCommand from '../InitDirectoryCommand';
import CleanRunDataCommand from '../CleanRunDataCommand';
import {startInteractionTests} from './BrowserTest';

export default class RunAllInteractionTestsCommand extends BaseCommand {
  getCommandName(): string {
    return 'quick-interaction-test';
  }

  getDescription(): string {
    return 'Run all test scenarios in quick test mode';
  }

  getCategory(): CommandCategory {
    return CommandCategory.DEV;
  }

  getPrerequisites(): BaseCommand[] {
    return [new CleanRunDataCommand(), new InitDirectoryCommand()];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(_options: CLIOptions): Promise<void> {
    startInteractionTests();
  }
}
