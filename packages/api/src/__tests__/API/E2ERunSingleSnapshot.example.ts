/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
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
