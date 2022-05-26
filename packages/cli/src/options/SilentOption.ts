/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class SilentOption extends BaseOption {
  getOptionName(): string {
    return 'silent';
  }

  getOptionShortcut(): string {
    return 's';
  }

  getDescription(): string {
    return 'mute all terminal output';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()] || args[this.getOptionShortcut()]) {
      config.muteConsole = true;
    }
  }
}
