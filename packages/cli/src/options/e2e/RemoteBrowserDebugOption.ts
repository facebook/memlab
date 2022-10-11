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
import {OPTION_NAME} from "../constant";

export default class RemoteBrowserDebugOption extends BaseOption {
  getOptionName(): string {
    return OPTION_NAME.LOCAL_PUPPETEER;
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
