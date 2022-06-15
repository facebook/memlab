/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {Browser} from 'puppeteer';
import type {MemLabConfig} from '@memlab/core';

import {config, constant, utils} from '@memlab/core';

const puppeteer = constant.isFRL
  ? {}
  : constant.isFB
  ? require('puppeteer-core')
  : require('puppeteer');

async function getBrowser(
  options: {config?: MemLabConfig; warmup?: boolean} = {},
): Promise<Browser> {
  const runConfig = options.config ?? config;
  let browser: Browser;
  if (runConfig.isLocalPuppeteer && !options.warmup) {
    try {
      browser = await puppeteer.connect({
        browserURL: `http://localhost:${runConfig.localBrowserPort}`,
        ...runConfig.puppeteerConfig,
      });
    } catch (e) {
      throw utils.haltOrThrow(utils.getError(e), {
        primaryMessageToPrint:
          'Failed to connect to local browser. Ensure that the local-puppeteer script is running.',
      });
    }
  } else {
    browser = await puppeteer.launch(runConfig.puppeteerConfig);
  }
  return browser;
}

export default {
  getBrowser,
};
