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
import path from 'path';
import fs from 'fs';
import {distPath, wait} from '../utils/test-utils';

test.describe('run.bundle.js functionality', () => {
  test('should load and execute correctly', async ({page}) => {
    // Get absolute path to the bundle file
    const bundlePath = path.join(distPath, 'run.bundle.js');
    const bundleCode = fs.readFileSync(bundlePath, 'utf8');

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
