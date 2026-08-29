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

export default class AnonymizeAuditOnlyOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.ANONYMIZE_AUDIT_ONLY;
  }

  getDescription(): string {
    return (
      'report what would be redacted and what would be left in the clear, ' +
      'without writing a file. Use it on a capture someone already ' +
      'anonymized to check whether anything was missed'
    );
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const value = args[this.getOptionName()];
    if (value != null && typeof value !== 'boolean') {
      utils.haltOrThrow(
        `--${this.getOptionName()} is a flag and takes no value, got: ${value}`,
      );
    }
  }
}
