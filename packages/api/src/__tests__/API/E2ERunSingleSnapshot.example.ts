/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import path from 'path';
import {Page} from 'puppeteer';
import {StringAnalysis, run} from '../../index';

const scenario = {
  app: () => 'test-spa',
  url: () => '',
  action: async (page: Page): Promise<void> =>
    await page.click('[data-testid="link-4"]'),
};

const promise = run({
  scenario,
});

promise.then(result => {
  const analysis = new StringAnalysis();
  const snapshotFile = path.join(result.config.curDataDir, 's3.heapsnapshot');
  analysis.analyzeSnapshotFromFile(snapshotFile);
});
