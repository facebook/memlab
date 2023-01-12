/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {Page} from 'puppeteer';
import type {IHeapNode, IScenario} from '@memlab/core';

import {run} from '../../index';
import {testSetup, testTimeout} from './lib/E2ETestSettings';

beforeEach(testSetup);

test(
  'self-defined leak detector can find Web Worker TestObject (in initial load)',
  async () => {
    const selfDefinedScenario: IScenario = {
      app: (): string => 'test-spa',
      url: (): string => '',
      leakFilter: (node: IHeapNode) => {
        return node.name === 'WorkerTestObject' && node.type === 'object';
      },
    };

    const result = await run({
      scenario: selfDefinedScenario,
      webWorker: null,
    });
    // detected all different leak trace cluster
    expect(result.leaks.length).toBe(1);
  },
  testTimeout,
);

test(
  'self-defined leak detector can find Web Worker TestObject with specified worker name (in initial load)',
  async () => {
    const selfDefinedScenario: IScenario = {
      app: (): string => 'test-spa',
      url: (): string => '',
      leakFilter: (node: IHeapNode) => {
        return node.name === 'WorkerTestObject' && node.type === 'object';
      },
    };

    const result = await run({
      scenario: selfDefinedScenario,
      webWorker: 'test-worker',
    });
    // detected all different leak trace cluster
    expect(result.leaks.length).toBe(1);
  },
  testTimeout,
);

test(
  'self-defined leak detector can find Web Worker TestObject (during interaction)',
  async () => {
    const selfDefinedScenario: IScenario = {
      app: (): string => 'test-spa',
      url: (): string => '',
      action: async (page: Page): Promise<void> =>
        await page.click('[data-testid="link-4"]'),
      leakFilter: (node: IHeapNode) => {
        return node.name === 'WorkerTestObject' && node.type === 'object';
      },
    };

    const result = await run({
      scenario: selfDefinedScenario,
      webWorker: null,
    });
    // detected all different leak trace cluster
    expect(result.leaks.length).toBe(1);
  },
  testTimeout,
);
