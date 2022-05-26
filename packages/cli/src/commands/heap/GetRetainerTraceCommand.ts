/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {CLIOptions, Optional} from '@memlab/core';

import fs from 'fs-extra';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import {BaseOption, analysis, utils} from '@memlab/core';
import SnapshotFileOption from '../../options/heap/SnapshotFileOption';
import JSEngineOption from '../../options/heap/JSEngineOption';
import HeapNodeIdOption from '../../options/HeapNodeIdOption';
import SnapshotDirectoryOption from '../../options/heap/SnapshotDirectoryOption';
import {fileManager} from '@memlab/core';

async function calculateRetainerTrace(): Promise<void> {
  const snapshotPath = utils.getSingleSnapshotFileForAnalysis();
  await analysis.focus({file: snapshotPath});
}

export default class GetRetainerTraceCommand extends BaseCommand {
  getCommandName(): string {
    return 'report';
  }

  getDescription(): string {
    return 'report retainer trace of a specific node, use with --nodeId';
  }

  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }

  getExamples(): string[] {
    return ['--nodeId=@3123123'];
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
