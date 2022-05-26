/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class SkipExtraOperationOption extends BaseOption {
  getOptionName(): string {
    return 'skip-extra-ops';
  }

  getDescription(): string {
    return 'skip doing extra interactions (e.g., scrolling and waiting) on target and final page';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args['skip-extra-ops'] || args['skip-extra-op']) {
      config.skipExtraOps = true;
    }
  }
}
