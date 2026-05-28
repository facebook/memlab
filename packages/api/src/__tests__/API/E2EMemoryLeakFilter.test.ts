/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/* eslint-disable @typescript-eslint/ban-ts-comment */

import type {Page} from 'puppeteer-core';
import type {
  IHeapEdge,
  IHeapNode,
  IHeapSnapshot,
  IScenario,
} from '@memlab/core';

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import {run} from '../../index';
import {getUniqueID, testSetup, testTimeout} from './lib/E2ETestSettings';

beforeEach(testSetup);

function hasPathEdgeWithName(
  leak: Record<string, unknown>,
  edgeName: string,
): boolean {
  return Object.keys(leak).some(key => key.includes(`--${edgeName} (`));
}

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
    };

    const workDir = path.join(os.tmpdir(), 'memlab-api-test', getUniqueID());
    fs.mkdirsSync(workDir);

    const result = await run({
      scenario: selfDefinedScenario,
      evalInBrowserAfterInitLoad: injectDetachedDOMElements,
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

test(
  'self-defined retainer trace filter work as expected (part 1)',
  async () => {
    const selfDefinedScenario: IScenario = {
      app: (): string => 'test-spa',
      url: (): string => '',
      action: async (page: Page): Promise<void> =>
        await page.click('[data-testid="link-4"]'),
      retainerReferenceFilter: (
        edge: IHeapEdge,
        _snapshot: IHeapSnapshot,
        isReferenceUsedByDefault: boolean,
      ) => {
        if (edge.name_or_index === '_path_1') {
          return false;
        }
        return isReferenceUsedByDefault;
      },
    };

    const workDir = path.join(os.tmpdir(), 'memlab-api-test', getUniqueID());
    fs.mkdirsSync(workDir);

    const result = await run({
      scenario: selfDefinedScenario,
      evalInBrowserAfterInitLoad: injectDetachedDOMElements,
      workDir,
    });
    // detected leak trace clusters
    expect(result.leaks.length).toBeGreaterThanOrEqual(1);
    // expect none of the retainer trace paths to go through _path_1
    expect(
      result.leaks.every(leak => !hasPathEdgeWithName(leak, '_path_1')),
    ).toBe(true);
    // expect some of the retainer trace paths to go through _path_2
    expect(
      result.leaks.some(leak => hasPathEdgeWithName(leak, '_path_2')),
    ).toBe(true);
    const reader = result.runResult;
    expect(path.resolve(reader.getRootDirectory())).toBe(path.resolve(workDir));
  },
  testTimeout,
);

test(
  'self-defined retainer trace filter work as expected (part 2)',
  async () => {
    const selfDefinedScenario: IScenario = {
      app: (): string => 'test-spa',
      url: (): string => '',
      action: async (page: Page): Promise<void> =>
        await page.click('[data-testid="link-4"]'),
      retainerReferenceFilter: (
        edge: IHeapEdge,
        _snapshot: IHeapSnapshot,
        isReferenceUsedByDefault: boolean,
      ) => {
        if (edge.name_or_index === '_path_2') {
          return false;
        }
        return isReferenceUsedByDefault;
      },
    };

    const workDir = path.join(os.tmpdir(), 'memlab-api-test', getUniqueID());
    fs.mkdirsSync(workDir);

    const result = await run({
      scenario: selfDefinedScenario,
      evalInBrowserAfterInitLoad: injectDetachedDOMElements,
      workDir,
    });
    // detected leak trace clusters
    expect(result.leaks.length).toBeGreaterThanOrEqual(1);
    // expect none of the retainer trace paths to go through _path_2
    expect(
      result.leaks.every(leak => !hasPathEdgeWithName(leak, '_path_2')),
    ).toBe(true);
    // expect some of the retainer trace paths to go through _path_1
    expect(
      result.leaks.some(leak => hasPathEdgeWithName(leak, '_path_1')),
    ).toBe(true);
    const reader = result.runResult;
    expect(path.resolve(reader.getRootDirectory())).toBe(path.resolve(workDir));
  },
  testTimeout,
);
