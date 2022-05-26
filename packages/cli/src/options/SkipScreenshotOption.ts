/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class SkipScreenshotOption extends BaseOption {
  getOptionName(): string {
    return 'skip-screenshot';
  }

  getDescription(): string {
    return 'skip taking screenshots';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args['skip-screenshot']) {
      config.skipScreenshot = true;
    }
  }
}
