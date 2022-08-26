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

import {BaseOption} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import {BaseAnalysis} from '@memlab/heap-analysis';

export default class HeapAnalysisSubCommandWrapper extends BaseCommand {
  private heapAnalysis: BaseAnalysis;

  constructor(analysis: BaseAnalysis) {
    super();
    this.heapAnalysis = analysis;
  }

  getCommandName(): string {
    return this.heapAnalysis.getCommandName();
  }

  getDescription(): string {
    return this.heapAnalysis.getDescription();
  }

  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }

  getOptions(): BaseOption[] {
    return this.heapAnalysis.getOptions();
  }

  async run(options: CLIOptions): Promise<void> {
    await this.heapAnalysis.run({args: options.cliArgs});
  }
}
