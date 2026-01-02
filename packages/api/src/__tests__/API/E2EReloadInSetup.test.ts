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

import type {Page} from 'puppeteer-core';

import {run} from '../../index';
import {scenario, testSetup, testTimeout} from './lib/E2ETestSettings';

beforeEach(testSetup);

// clear the page reload check in setup
// to check that the page reload check should
// be injected after the setup callback
const setup = async (page: Page) => {
  await page.evaluate(() => {
    // @ts-ignore
    delete window.__memlab_check_reload;
  });
};

test(
  'reload in setup is fine',
  async () => {
    const {leaks} = await run({
      scenario: {
        ...scenario,
        setup,
      },
    });
    // no memory leaks are detected
    expect(leaks.length).toBe(0);
  },
  testTimeout,
);
