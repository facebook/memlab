/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
/* eslint-disable @typescript-eslint/ban-ts-comment */

import {Page} from 'puppeteer';
import {ShapeUnboundGrowthAnalysis, run} from '../../index';

const scenario = {
  app: () => 'test-spa',
  url: () => '',
  action: async (page: Page): Promise<void> =>
    await page.click('[data-testid="link-4"]'),
  repeat: () => 4,
};

function inject() {
  // @ts-ignore
  window.injectHookForLink4 = () => {
    class LeakObject {
      public value: string;
      constructor() {
        this.value = `value: ${Math.random()}`;
      }
    }
    // @ts-ignore
    const leak = (window.__injectedValue = window.__injectedValue || []);
    for (let i = 0; i < 10000; ++i) {
      leak.push(new LeakObject());
    }
  };
}

const promise = run({
  scenario,
  evalInBrowserAfterInitLoad: inject,
  snapshotForEachStep: true,
});

promise.then(() => {
  // test analysis from auto loading
  const analysis = new ShapeUnboundGrowthAnalysis();
  analysis.run();
});
