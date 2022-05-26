/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class SkipWarmupOption extends BaseOption {
  getOptionName(): string {
    return 'skip-warmup';
  }

  getDescription(): string {
    return 'skip warming up web server';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()]) {
      config.skipWarmup = true;
    }
  }
}
