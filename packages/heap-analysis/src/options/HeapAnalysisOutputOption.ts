/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {ParsedArgs} from 'minimist';
import {MemLabConfig, OutputFormat, utils} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class HeapAnalysisOutputOption extends BaseOption {
  getOptionName(): string {
    return 'output';
  }

  getDescription(): string {
    const options = this.getExampleValues()
      .map(v => `'${v}'`)
      .join(', ');
    return (
      'specify output format of the analysis ' +
      `(available options: ${options}; defaults to 'text')`
    );
  }

  getExampleValues(): string[] {
    return ['text', 'json'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const name = this.getOptionName();
    const format = args[name] == null ? 'text' : `${args[name]}`;
    config.outputFormat = HeapAnalysisOutputOption.parseOutputFormat(format);
    if (config.outputFormat === OutputFormat.Json) {
      config.isContinuousTest = true;
    }
  }

  private static parseOutputFormat(s: string): OutputFormat {
    switch (s.toLowerCase()) {
      case 'text':
        return OutputFormat.Text;
      case 'json':
        return OutputFormat.Json;
      default:
        utils.haltOrThrow('Invalid output format, valid output: text, json');
        return OutputFormat.Text;
    }
  }
}
