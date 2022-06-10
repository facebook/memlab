/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {BaseOption, CLIOptions, Optional} from '@memlab/core';

import fs from 'fs';
import path from 'path';
import {fileManager} from '@memlab/core';
import BaseCommand from '../BaseCommand';
import CheckLeakCommand from './heap/CheckLeakCommand';
import InitDirectoryCommand from './InitDirectoryCommand';
import TakeSnapshotCommand from './snapshot/TakeSnapshotCommand';
import SetWorkingDirectoryOption from '../options/SetWorkingDirectoryOption';

export default class MemLabRunCommand extends BaseCommand {
  getCommandName(): string {
    return 'run';
  }

  getDescription(): string {
    return 'find memory leaks in web apps';
  }

  getExamples(): string[] {
    return ['--app=comet --interaction=watch'];
  }

  getPrerequisites(): BaseCommand[] {
    return [
      new InitDirectoryCommand(),
      new TakeSnapshotCommand(),
      new CheckLeakCommand(),
    ];
  }

  getOptions(): BaseOption[] {
    return [new SetWorkingDirectoryOption()];
  }

  async run(options: CLIOptions): Promise<void> {
    // move leaks.txt file
    const workDir = options.configFromOptions?.workDir as Optional<string>;
    const outDir = fileManager.getDataOutDir({workDir});
    const leakSrcFile = path.join(outDir, 'leaks.txt');
    const content = fs.readFileSync(leakSrcFile, 'UTF-8');
    const curDataDir = fileManager.getCurDataDir({workDir});
    const leakDestFile = path.join(curDataDir, 'leaks.txt');
    fs.writeFileSync(leakDestFile, content, 'UTF-8');
  }
}
