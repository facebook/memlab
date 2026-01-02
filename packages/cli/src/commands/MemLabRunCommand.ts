/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {
  BaseOption,
  CLIOptions,
  CommandOptionExample,
  Optional,
} from '@memlab/core';

import fs from 'fs';
import path from 'path';
import {fileManager} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../BaseCommand';
import CheckLeakCommand from './heap/CheckLeakCommand';
import InitDirectoryCommand from './InitDirectoryCommand';
import TakeSnapshotCommand from './snapshot/TakeSnapshotCommand';
import SetWorkingDirectoryOption from '../options/SetWorkingDirectoryOption';
import AppOption from '../options/e2e/AppOption';
import InteractionOption from '../options/e2e/InteractionOption';
import SkipSnapshotOption from '../options/e2e/SkipSnapshotOption';
import RunningModeOption from '../options/e2e/RunningModeOption';
import BaselineFileOption from '../options/heap/BaselineFileOption';
import TargetFileOption from '../options/heap/TargetFileOption';
import FinalFileOption from '../options/heap/FinalFileOption';
import SnapshotDirectoryOption from '../options/heap/SnapshotDirectoryOption';
import JSEngineOption from '../options/heap/JSEngineOption';
import HeapParserDictFastStoreSizeOption from '../options/heap/HeapParserDictFastStoreSizeOption';

export default class MemLabRunCommand extends BaseCommand {
  getCommandName(): string {
    return 'run';
  }

  getDescription(): string {
    return 'find memory leaks in web apps';
  }

  getExamples(): CommandOptionExample[] {
    return [
      '--scenario <TEST_SCENARIO_FILE>',
      '--scenario /tmp/test-scenario.js',
      '--scenario /tmp/test-scenario.js --work-dir /tmp/test-1/',
    ];
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

  getExcludedOptions(): BaseOption[] {
    return [
      new AppOption(),
      new InteractionOption(),
      new SkipSnapshotOption(),
      new RunningModeOption(),
      new BaselineFileOption(),
      new TargetFileOption(),
      new FinalFileOption(),
      new SnapshotDirectoryOption(),
      new JSEngineOption(),
      new HeapParserDictFastStoreSizeOption(),
    ];
  }

  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }

  async run(options: CLIOptions): Promise<void> {
    // move leaks.txt file
    const workDir = options.configFromOptions?.workDir as Optional<string>;
    const outDir = fileManager.getDataOutDir({workDir});
    const leakSrcFile = path.join(outDir, 'leaks.txt');
    const content = fs.readFileSync(leakSrcFile, {encoding: 'utf8'});
    const curDataDir = fileManager.getCurDataDir({workDir});
    const leakDestFile = path.join(curDataDir, 'leaks.txt');
    fs.writeFileSync(leakDestFile, content, {encoding: 'utf8'});
  }
}
