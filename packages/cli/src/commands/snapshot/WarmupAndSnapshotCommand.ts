/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import type {CLIOptions} from '@memlab/core';
import BaseCommand from '../../BaseCommand';
import InitDirectoryCommand from '../InitDirectoryCommand';
import WarmupAppCommand from '../WarmupAppCommand';
import TakeSnapshotCommand from './TakeSnapshotCommand';

export default class WarmupAndSnapshotCommand extends BaseCommand {
  getCommandName(): string {
    return 'warmup-and-snapshot';
  }

  getDescription(): string {
    return 'Warm up server and take heap snapshots';
  }

  getPrerequisites(): BaseCommand[] {
    return [
      new InitDirectoryCommand(),
      new WarmupAppCommand(),
      new TakeSnapshotCommand(),
    ];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(_options: CLIOptions): Promise<void> {
    // do nothing
  }
}
