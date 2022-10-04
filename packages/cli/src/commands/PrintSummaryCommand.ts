/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {CLIOptions, Optional} from '@memlab/core';

import fs from 'fs-extra';
import {utils} from '@memlab/core';
import BaseCommand from '../BaseCommand';
import {fileManager, info, BaseOption} from '@memlab/core';
import SetWorkingDirectoryOption from '../options/SetWorkingDirectoryOption';

export default class PrintSummaryCommand extends BaseCommand {
  getCommandName(): string {
    return 'summary';
  }

  getDescription(): string {
    return 'Print summary of the last check leak run';
  }

  isInternalCommand(): boolean {
    return true;
  }

  getOptions(): BaseOption[] {
    return [new SetWorkingDirectoryOption()];
  }

  async run(options: CLIOptions): Promise<void> {
    const workDir = options.configFromOptions?.workDir as Optional<string>;
    const summaryFile = fileManager.getLeakSummaryFile({workDir});
    if (!fs.existsSync(summaryFile)) {
      utils.haltOrThrow(
        'No MemLab leak summary found. Please make sure "memlab find-leaks" runs successfully first.',
      );
    }
    const content = fs.readFileSync(summaryFile, 'UTF-8');
    info.topLevel(content);
  }
}
