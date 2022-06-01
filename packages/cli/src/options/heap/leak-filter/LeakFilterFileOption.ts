/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption, utils} from '@memlab/core';

export default class LeakFilterFileOption extends BaseOption {
  getOptionName(): string {
    return 'leak-filter';
  }

  getDescription(): string {
    return 'specify a definition JS file for leak filter';
  }

  getExampleValues(): string[] {
    return ['/tmp/leak-filter.js'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()]) {
      const file = args[this.getOptionName()];
      config.externalLeakFilter = utils.loadLeakFilter(file);
    }
  }
}
