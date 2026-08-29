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

const MODES = ['stable', 'uniform'];

export default class AnonymizeModeOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.ANONYMIZE_MODE;
  }

  getDescription(): string {
    return (
      'set how redacted text is generated: ' +
      '`stable` (default) keeps distinct values distinct so duplication ' +
      'analysis stays accurate, `uniform` replaces every character with ?'
    );
  }

  getExampleValues(): string[] {
    // A copy: the same array backs the validation in `parse`, so handing the
    // live reference to a caller lets a mutation there decide what this option
    // accepts.
    return [...MODES];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const value = args[this.getOptionName()];
    if (value != null && !MODES.includes(String(value))) {
      utils.haltOrThrow(
        `Invalid --${this.getOptionName()}: ${value}. Expected one of: ${MODES.join(', ')}`,
      );
    }
  }
}
