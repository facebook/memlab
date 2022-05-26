/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class SkipScrollOption extends BaseOption {
  getOptionName(): string {
    return 'skip-scroll';
  }

  getDescription(): string {
    return 'skip scrolling target page in browser';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args['skip-scroll']) {
      config.skipScroll = true;
    }
  }
}
