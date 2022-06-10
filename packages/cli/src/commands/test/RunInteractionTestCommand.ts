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
import {config, modes} from '@memlab/core';
import CleanRunDataCommand from '../CleanRunDataCommand';
import {runPageInteractionFromCLI} from '../snapshot/Snapshot';
import {warmup} from '@memlab/api';

export default class RunInteractionTestCommand extends BaseCommand {
  getCommandName(): string {
    return 'quick-interaction-test-single';
  }

  getDescription(): string {
    return 'Run test scenario in quick test mode';
  }

  getCategory(): CommandCategory {
    return CommandCategory.DEV;
  }

  getPrerequisites(): BaseCommand[] {
    return [new CleanRunDataCommand(), new InitDirectoryCommand()];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(_options: CLIOptions): Promise<void> {
    config.runningMode = modes.get('interaction-test', config);
    await warmup();
    await runPageInteractionFromCLI();
  }
}
