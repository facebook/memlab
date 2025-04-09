/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import {test, expect} from '@playwright/test';
import fs from 'fs';
import {wait} from '../utils/test-utils';
import {runBundleFilePath} from '../utils/test-utils';

test.describe('run.bundle.js functionality', () => {
  test('should load and execute correctly', async ({page}) => {
    const bundleCode = fs.readFileSync(runBundleFilePath, 'utf8');

    let bundleLoaded = false;
    // Listen for console messages
    page.on('console', message => {
      // add console.log(message) if you would like to debug
      const msgText = message.text();
      if (msgText.includes('duration:')) {
        bundleLoaded = true;
      }
    });

    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <script>
            window.TEST_MEMORY_SCAN = true;
          </script>
        </head>
        <body>
          <div id="test-container"></div>
          <script>
            ${bundleCode}
          </script>
        </body>
      </html>
    `);

    await wait(2000);

    // check if the bundle loaded successfully
    expect(bundleLoaded).toBe(true);
  });
});
