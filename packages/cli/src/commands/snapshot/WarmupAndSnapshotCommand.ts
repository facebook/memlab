/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
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
