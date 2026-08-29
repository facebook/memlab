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
import type {MemLabConfig} from '@memlab/core';
import {BaseOption, utils} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

export default class AnonymizeOutputOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.ANONYMIZE_OUTPUT;
  }

  getDescription(): string {
    return 'set file path to write the anonymized heap snapshot to';
  }

  getExampleValues(): string[] {
    return ['/tmp/shareable.heapsnapshot'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const value = args[this.getOptionName()];
    if (value != null && typeof value !== 'string') {
      utils.haltOrThrow(`Invalid --${this.getOptionName()} value: ${value}`);
    }
  }
}
