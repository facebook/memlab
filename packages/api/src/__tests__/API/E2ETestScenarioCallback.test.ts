/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

/* eslint-disable @typescript-eslint/ban-ts-comment */

import type {Page} from 'puppeteer';
import type {
  IHeapNode,
  IHeapSnapshot,
  IScenario,
  HeapNodeIdSet,
} from '@memlab/core';

import {run} from '../../index';
import {testSetup, testTimeout} from './lib/E2ETestSettings';

beforeEach(testSetup);

function injectDetachedDOMElements() {
  // @ts-ignore
  window.injectHookForLink4 = () => {
    class TestObject {
      key: 'value';
    }
    const arr = [];
    for (let i = 0; i < 23; ++i) {
      arr.push(document.createElement('div'));
    }
    // @ts-ignore
    window.__injectedValue = arr;
    // @ts-ignore
    window._path_1 = {x: {y: document.createElement('div')}};
    // @ts-ignore
    window._path_2 = new Set([document.createElement('div')]);
    // @ts-ignore
    window._randomObject = [new TestObject()];
  };
}

test(
  'callbacks in test scenarios are called in the right order',
  async () => {
    const actualCalls: string[] = [];

    // define a test scenario with all callbacks offered by memlab
    const selfDefinedScenario: IScenario = {
      app: (): string => {
        actualCalls.push('app');
        return 'test-spa';
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      beforeInitialPageLoad: async (_page: Page) => {
        actualCalls.push('beforeInitialPageLoad');
      },
      cookies: () => {
        actualCalls.push('cookies');
        return [];
      },
      repeat: () => {
        actualCalls.push('repeat');
        return 0;
      },
      isPageLoaded: async page => {
        actualCalls.push('isPageLoaded');
        await page.waitForNavigation({
          // consider navigation to be finished when there are
          // no more than 2 network connections for at least 500 ms.
          waitUntil: 'networkidle2',
          // Maximum navigation time in milliseconds
          timeout: 5000,
        });
        return true;
      },
      url: (): string => {
        actualCalls.push('url');
        return '';
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      setup: async (_page: Page) => {
        actualCalls.push('setup');
      },
      action: async (page: Page): Promise<void> => {
        actualCalls.push('action');
        await page.click('[data-testid="link-4"]');
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      back: async (_page: Page): Promise<void> => {
        actualCalls.push('back');
      },
      beforeLeakFilter: (
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _snapshot: IHeapSnapshot,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _leakedNodeIds: HeapNodeIdSet,
      ) => {
        actualCalls.push('beforeLeakFilter');
      },
      leakFilter: (node: IHeapNode) => {
        actualCalls.push('leakFilter');
        return node.name === 'TestObject' && node.type === 'object';
      },
    };
    // run test scenario
    await run({
      scenario: selfDefinedScenario,
      evalInBrowserAfterInitLoad: injectDetachedDOMElements,
      skipWarmup: true,
    });

    // squash all leakFilter call into a single identifier
    let normalizedCalls = squash(actualCalls, ['leakFilter', 'isPageLoaded']);
    normalizedCalls = normalizedCalls.slice(normalizedCalls.lastIndexOf('url'));

    // expect all callbacks are called in the right order
    expect(normalizedCalls).toEqual([
      // the first 4 calls (app, cookies, repeat, url) can be in any order
      'url',
      'repeat',
      'app',
      'cookies',
      // the following calls must be in the exact order listed
      'beforeInitialPageLoad',
      'isPageLoaded',
      'setup',
      'action',
      'isPageLoaded',
      'back',
      'isPageLoaded',
      'beforeLeakFilter',
      'leakFilter',
    ]);
  },
  testTimeout,
);

// Squashes consecutive occurrences of a specified element in
// an array into a single occurrence of that element
function squash(arr: string[], elementsToSquash: string[]): string[] {
  const squashSet = new Set(elementsToSquash);
  return arr.filter(
    (value, index) => !squashSet.has(value) || value !== arr[index - 1],
  );
}
