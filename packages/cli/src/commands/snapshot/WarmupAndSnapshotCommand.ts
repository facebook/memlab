/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
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

  getDocumenation(): string {
    const warmupCommand = new WarmupAppCommand();
    const warmupCLI = `memlab ${warmupCommand.getCommandName()}`;
    const takeSnapshotCommand = new TakeSnapshotCommand();
    const snapshotCLI = `memlab ${takeSnapshotCommand.getCommandName()}`;
    return `This is equivalent to running ${warmupCLI} and ${snapshotCLI}.`;
  }

  getExamples(): string[] {
    return [
      '--scenario <TEST_SCENARIO_FILE>',
      '--scenario /tmp/test-scenario.js',
      '--scenario /tmp/test-scenario.js --work-dir /tmp/test-1/',
    ];
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
