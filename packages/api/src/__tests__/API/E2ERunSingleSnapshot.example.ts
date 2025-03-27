/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {Page} from 'puppeteer';
import {StringAnalysis, warmupAndTakeSnapshots} from '../../index';

const scenario = {
  app: () => 'test-spa',
  url: () => '',
  action: async (page: Page): Promise<void> =>
    await page.click('[data-testid="link-4"]'),
};

async function test() {
  const result = await warmupAndTakeSnapshots({
    scenario,
  });
  const analysis = new StringAnalysis();
  const snapshotFile = result.getSnapshotFiles().pop() as string;
  analysis.analyzeSnapshotFromFile(snapshotFile);
}

test();
