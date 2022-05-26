/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class SkipGCOption extends BaseOption {
  getOptionName(): string {
    return 'skip-gc';
  }

  getDescription(): string {
    return 'skip doing garbage collection in browser';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()]) {
      config.skipGC = true;
    }
  }
}
