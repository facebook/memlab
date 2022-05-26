/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class SetContinuousTestOption extends BaseOption {
  getOptionName(): string {
    return 'sc';
  }

  getDescription(): string {
    return 'set to continuous test mode';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args['ContinuousTest'] || args[this.getOptionName()]) {
      config.isContinuousTest = true;
    }
  }
}
