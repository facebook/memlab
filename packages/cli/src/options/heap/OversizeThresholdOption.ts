/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class OversizeThresholdOption extends BaseOption {
  getOptionName(): string {
    return 'oversize-threshold';
  }

  getDescription(): string {
    return (
      'set oversize threshold (in bytes), objects with retained size ' +
      'bigger than the threshold will be considered as leaks'
    );
  }

  getExampleValues(): string[] {
    return ['1000', '1000000'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()]) {
      const sizeThreshold = parseInt(args[this.getOptionName()], 10);
      if (!isNaN(sizeThreshold)) {
        config.oversizeObjectAsLeak = true;
        config.oversizeThreshold = sizeThreshold;
      }
    }
  }
}
