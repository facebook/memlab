/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class FullExecutionOption extends BaseOption {
  getOptionName(): string {
    return 'full';
  }

  getDescription(): string {
    return 'take heap snapshot for every step in E2E interaction';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args.full) {
      config.isFullRun = true;
    }
  }
}
