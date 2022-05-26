/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class VerboseOption extends BaseOption {
  getOptionName(): string {
    return 'verbose';
  }

  getOptionShortcut(): string | null {
    return 'v';
  }

  getDescription(): string {
    return 'show more details';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args.verbose || args.v) {
      config.verbose = true;
    }
  }
}
