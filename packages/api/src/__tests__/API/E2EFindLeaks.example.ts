/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/* eslint-disable @typescript-eslint/ban-ts-comment */

import {info} from '@memlab/core';
import {Page} from 'puppeteer';
import {run} from '../../index';

const scenario = {
  app: () => 'test-spa',
  url: () => '',
  action: async (page: Page): Promise<void> =>
    await page.click('[data-testid="link-4"]'),
};

function inject() {
  // @ts-ignore
  window.injectHookForLink4 = () => {
    const arr = [];
    for (let i = 0; i < 23; ++i) {
      arr.push(document.createElement('div'));
    }
    // @ts-ignore
    window.__injectedValue = arr;
    // @ts-ignore
    window._path_1 = {x: {y: document.createElement('div')}};
    // @ts-ignore
    window._path_2 = new Set([document.createElement('div')]);
  };
}

async function test() {
  const {leaks} = await run({scenario, evalInBrowserAfterInitLoad: inject});
  info.lowLevel(`${leaks.length}`);
}

test();
