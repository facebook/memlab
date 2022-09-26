/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import type {CLIOptions, Optional} from '@memlab/core';

import fs from 'fs-extra';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import {BaseOption, analysis, utils} from '@memlab/core';
import SnapshotFileOption from '../../options/heap/SnapshotFileOption';
import JSEngineOption from '../../options/heap/JSEngineOption';
import HeapNodeIdOption from '../../options/heap/HeapNodeIdOption';
import SnapshotDirectoryOption from '../../options/heap/SnapshotDirectoryOption';
import {fileManager} from '@memlab/core';

async function calculateRetainerTrace(): Promise<void> {
  const snapshotPath = utils.getSingleSnapshotFileForAnalysis();
  await analysis.focus({file: snapshotPath});
}

export default class GetRetainerTraceCommand extends BaseCommand {
  getCommandName(): string {
    return 'trace';
  }

  getDescription(): string {
    return 'report retainer trace of a specific node, use with --nodeId';
  }

  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }

  getExamples(): string[] {
    return [
      '--node-id=<HEAP_OBJECT_ID>',
      '--node-id=@3123123',
      '--node-id=128127',
    ];
  }

  getOptions(): BaseOption[] {
    return [
      new SnapshotFileOption(),
      new SnapshotDirectoryOption(),
      new JSEngineOption(),
      new HeapNodeIdOption().required(),
    ];
  }

  async run(options: CLIOptions): Promise<void> {
    const workDir = options.configFromOptions?.workDir as Optional<string>;
    const reportOutDir = fileManager.getReportOutDir({workDir});
    fs.emptyDirSync(reportOutDir);

    await calculateRetainerTrace();
  }
}
