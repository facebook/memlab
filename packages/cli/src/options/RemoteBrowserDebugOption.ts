/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class RemoteBrowserDebugOption extends BaseOption {
  getOptionName(): string {
    return 'local-puppeteer';
  }

  getDescription(): string {
    return 'enable remote browser instance debugging via local puppeteer';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args['local-puppeteer']) {
      config.isLocalPuppeteer = true;
    }
  }
}
