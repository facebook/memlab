/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type {AnyValue} from '../../core/types';

import {test, expect} from '@playwright/test';
import path from 'path';
import fs from 'fs';
import {srcPath} from '../utils/test-utils';
import {libBundleFilePath} from '../utils/test-utils';

test('scan should identify react components (React 18 Dev)', async ({page}) => {
  const bundleCode = fs.readFileSync(libBundleFilePath, 'utf8');

  const reactDevPath = path.join(srcPath, 'tests', 'lib', 'react-v18.dev.js');
  const reactDevCode = fs.readFileSync(reactDevPath, 'utf8');

  const reactDOMDevPath = path.join(
    srcPath,
    'tests',
    'lib',
    'react-dom-v18.dev.js',
  );
  const reactDOMDevCode = fs.readFileSync(reactDOMDevPath, 'utf8');

  // Create a simple test page with React and a custom component
  await page.setContent(`
    <html>
      <body>
        <div id="root"></div>
        <script>${reactDevCode}</script>
        <script>${reactDOMDevCode}</script>
        <script>${bundleCode}</script>
        <script>
          function TestContainer() {
            return React.createElement(
              'div',
              null,
              React.createElement(TestComponent),
              React.createElement(TestComponent)
            );
          }

          function TestComponent() {
            return React.createElement('div', null, 'Test Component');
          }

          ReactDOM.render(
            React.createElement(TestContainer),
            document.getElementById('root')
          );
        </script>
      </body>
    </html>
  `);

  // Now the global `MemLens` should be available in the page
  const componentIdentified = await page.evaluate(() => {
    const createReactMemoryScan = (window as AnyValue).MemLens
      .createReactMemoryScan;
    const instance = createReactMemoryScan();
    const analysisResult = instance.scan();
    const componentCountCorrect =
      analysisResult.componentToFiberNodeCount.get('TestComponent') === 2;
    const containerCountCorrect =
      analysisResult.componentToFiberNodeCount.get('TestContainer') === 1;
    return componentCountCorrect && containerCountCorrect;
  });

  expect(componentIdentified).toBe(true);
});
