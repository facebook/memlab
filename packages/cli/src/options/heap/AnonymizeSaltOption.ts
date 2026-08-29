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

export default class AnonymizeSaltOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.ANONYMIZE_SALT;
  }

  getDescription(): string {
    return (
      'set a salt for the replacement text. Without one the mapping is the ' +
      'same in every capture, which keeps a set of snapshots comparable but ' +
      'lets anyone holding a candidate value confirm it. Use the SAME salt ' +
      'for every file in a set'
    );
  }

  getExampleValues(): string[] {
    return ['my-team-salt'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const value = args[this.getOptionName()];
    if (value != null && typeof value !== 'string') {
      utils.haltOrThrow(`Invalid --${this.getOptionName()} value: ${value}`);
    }
  }
}
