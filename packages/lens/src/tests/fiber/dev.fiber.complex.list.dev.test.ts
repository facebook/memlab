/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import {AnyValue} from '../../core/types';
import {test, expect} from '@playwright/test';
import path from 'path';
import fs from 'fs';
import {srcPath} from '../utils/test-utils';
import {libBundleFilePath} from '../utils/test-utils';

test('scan should identify react components in a complex list fiber tree (React 18 Dev)', async ({
  page,
}) => {
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

  // Create a test page with React and some list components
  await page.setContent(`
    <html>
      <body>
        <div id="root"></div>
        <script>${reactDevCode}</script>
        <script>${reactDOMDevCode}</script>
        <script>${bundleCode}</script>
        <script>
          function ListItem({ text, count }) {
            return React.createElement('li', null, \`$\{text} ($\{count})\`);
          }

          function List({ items }) {
            return React.createElement(
              'ul',
              { className: 'list-container' },
              items.map((item, index) =>
                React.createElement(ListItem, {
                  key: index,
                  text: item.text,
                  count: item.count
                })
              )
            );
          }

          function Counter({ initialCount }) {
            const [count, setCount] = React.useState(initialCount);

            return React.createElement(
              'div',
              { className: 'counter' },
              React.createElement('span', null, \`Count: $\{count}\`),
              React.createElement(
                'button',
                { onClick: () => setCount(count + 1) },
                'Increment'
              )
            );
          }

          function TestContainer() {
            const listSetup = [];
            for (let i = 0; i < 1000; ++i) {
              listSetup.push({ text: 'Item ' + i, count: i });
            }
            const [items] = React.useState(listSetup);

            return React.createElement(
              'div',
              { className: 'container' },
              React.createElement('h1', null, 'Test Application'),
              React.createElement(Counter, { initialCount: 0 }),
              React.createElement(Counter, { initialCount: 10 }),
              React.createElement(List, { items: items }),
              React.createElement(List, { items: items.slice(0, 500) })
            );
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
    const counterCorrect =
      analysisResult.componentToFiberNodeCount.get('Counter') === 2;
    const listCorrect =
      analysisResult.componentToFiberNodeCount.get('List') === 2;
    const listItemCorrect =
      analysisResult.componentToFiberNodeCount.get('ListItem') === 1500;
    return counterCorrect && listCorrect && listItemCorrect;
  });

  expect(componentIdentified).toBe(true);
});
