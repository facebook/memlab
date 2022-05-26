/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class DisableXvfbOption extends BaseOption {
  getOptionName(): string {
    return 'disable-xvfb';
  }

  getDescription(): string {
    return 'disable Xvfb (X virtual framebuffer) for simulating headful browser rendering';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args['disable-xvfb']) {
      config.useXVFB = false;
    }
  }
}
