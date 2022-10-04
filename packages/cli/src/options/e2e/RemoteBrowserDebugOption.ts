/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
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
