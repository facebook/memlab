/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type { ParsedArgs } from 'minimist';
import { AnyRecord, MemLabConfig, OutputFormat, utils } from '@memlab/core';
import { BaseOption } from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

export default class AnalysisOutputOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.OUTPUT;
  }

  getDescription(): string {
    return (
      'specify output format of the analysis (defaults to text)'
    );
  }

  getExampleValues(): string[] {
    return ['text', 'json'];
  }

  async parse(
    config: MemLabConfig,
    args: ParsedArgs,
  ): Promise<void> {
    const name = this.getOptionName();
    config.outputFormat = AnalysisOutputOption.parseOutputFormat(args[name]);
    if (config.outputFormat === OutputFormat.Json){
      config.isContinuousTest = true;
    }
  }

  private static parseOutputFormat(s: string): OutputFormat {
    switch (s.toLowerCase()) {
      case "text":
        return OutputFormat.Text;
      case "json":
        return OutputFormat.Json;
      default:
        utils.haltOrThrow("Invalid output format");
        return OutputFormat.Text;
    }
  }
}
