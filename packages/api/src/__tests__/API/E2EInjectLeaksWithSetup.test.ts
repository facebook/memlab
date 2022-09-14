/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

/* eslint-disable @typescript-eslint/ban-ts-comment */

import type {Page} from 'puppeteer';
import type {IHeapNode, IScenario} from '@memlab/core';

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import {run} from '../../index';
import {scenario, testSetup, testTimeout} from './lib/E2ETestSettings';

beforeEach(testSetup);

// This test uses scenario.setup callback
// to set window.injectHookForLink4
// which injects memory leaks.
// The following test cases will check
// if MemLab can detect the injected memory leaks.
const setup = async (page: Page) => {
  page.evaluate(() => {
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
  });
};

test(
  'leak detector can find detached DOM elements',
  async () => {
    const {leaks} = await run({
      scenario: {
        ...scenario,
        setup,
      },
    });
    // detected all different leak trace cluster
    expect(leaks.length >= 1).toBe(true);
    // expect all traces are found
    expect(
      leaks.some(leak => JSON.stringify(leak).includes('__injectedValue')),
    );
    expect(leaks.some(leak => JSON.stringify(leak).includes('_path_1')));
    expect(leaks.some(leak => JSON.stringify(leak).includes('_path_2')));
  },
  testTimeout,
);

test(
  'self-defined leak detector can find TestObject',
  async () => {
    const selfDefinedScenario: IScenario = {
      app: (): string => 'test-spa',
      url: (): string => '',
      action: async (page: Page): Promise<void> =>
        await page.click('[data-testid="link-4"]'),
      leakFilter: (node: IHeapNode) => {
        return node.name === 'TestObject' && node.type === 'object';
      },
      setup,
    };

    const workDir = path.join(os.tmpdir(), 'memlab-api-test', `${process.pid}`);
    fs.mkdirsSync(workDir);

    const result = await run({
      scenario: selfDefinedScenario,
      workDir,
    });
    // detected all different leak trace cluster
    expect(result.leaks.length).toBe(1);
    // expect all traces are found
    expect(
      result.leaks.some(leak => JSON.stringify(leak).includes('_randomObject')),
    );
    const reader = result.runResult;
    expect(path.resolve(reader.getRootDirectory())).toBe(path.resolve(workDir));
  },
  testTimeout,
);
