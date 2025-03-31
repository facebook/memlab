/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
const path = require('path');
const {chromium, devices} = require('playwright');

// eslint-disable-next-line fb-www/async-iife-termination
(async () => {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const scriptName = path.basename(__filename);
    console.error(`Usage: node ${scriptName} <path-to-html-file>`);
    process.exit(1);
  }

  let filePath = args[0];
  if (!path.isAbsolute(filePath)) {
    filePath = path.resolve(__dirname, filePath);
  }

  const browser = await chromium.launch({
    headless: false,
    args: ['--auto-open-devtools-for-tabs'],
  });

  const context = await browser.newContext({
    ...devices['Desktop Chrome'],
  });

  const page = await context.newPage();
  await page.goto('file://' + filePath);

  // Don’t close the browser so you can inspect
})();
