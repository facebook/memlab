/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class HelperOption extends BaseOption {
  getOptionName(): string {
    return 'help';
  }

  getOptionShortcut(): string {
    return 'h';
  }

  getDescription(): string {
    return 'print helper text';
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async parse(_config: MemLabConfig, _args: ParsedArgs): Promise<void> {
    // the logic is done in dispatcher
  }
}
