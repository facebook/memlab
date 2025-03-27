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

import type {Page} from 'puppeteer';
import type {IScenario} from '@memlab/core';

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import {run} from '../../index';
import {testSetup, testTimeout} from './lib/E2ETestSettings';

beforeEach(testSetup);

// eslint-disable-next-line @typescript-eslint/ban-types
type Objectish = object | Function;

// The structure of classes and objects should be fixed
// so that MemLab can analyze them correctly in heap.
type TrackedItem = {
  useCaseId: string;
  taggedObjects: WeakSet<Objectish>;
};

function tagObjectsAsLeaks() {
  // this class definition must be defined within `tagObjectsAsLeaks`
  // since this function will be serialized and executed in browser context
  class MemLabTracker {
    memlabIdentifier: string;
    tagToTrackedObjectsMap: Map<string, TrackedItem>;

    constructor() {
      this.memlabIdentifier = 'MemLabObjectTracker';
      this.tagToTrackedObjectsMap = new Map();
    }

    tag(target: Objectish, useCaseId = 'MEMLAB_TAGGED'): void {
      let trackedItems = this.tagToTrackedObjectsMap.get(useCaseId);
      if (!trackedItems) {
        trackedItems = {
          useCaseId,
          taggedObjects: new WeakSet(),
        };
        this.tagToTrackedObjectsMap.set(useCaseId, trackedItems);
      }
      trackedItems.taggedObjects.add(target);
    }
  }

  // @ts-ignore
  window.injectHookForLink4 = () => {
    // @ts-ignore
    const tracker = (window._memlabTrack = new MemLabTracker());
    const leaks: Array<{x: number}> = [];
    // @ts-ignore
    window._taggedLeaks = leaks;
    for (let i = 0; i < 11; ++i) {
      leaks.push({x: i});
    }
    leaks.forEach(item => {
      tracker.tag(item);
    });
  };
}

test(
  'tagged leak objects can be identified as leaks',
  async () => {
    const selfDefinedScenario: IScenario = {
      app: (): string => 'test-spa',
      url: (): string => '',
      action: async (page: Page): Promise<void> =>
        await page.click('[data-testid="link-4"]'),
    };

    const workDir = path.join(os.tmpdir(), 'memlab-api-test', `${process.pid}`);
    fs.mkdirsSync(workDir);

    const result = await run({
      scenario: selfDefinedScenario,
      evalInBrowserAfterInitLoad: tagObjectsAsLeaks,
      workDir,
    });
    // tagged objects should be detected as leaks
    expect(result.leaks.length).toBe(1);
    // expect all traces are found
    expect(
      result.leaks.some(leak => JSON.stringify(leak).includes('_taggedLeaks')),
    );
  },
  testTimeout,
);
