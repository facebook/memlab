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

import fs from 'fs';
import BrowserInteractionResultReader from '../../result-reader/BrowserInteractionResultReader';
import {findLeaks, warmupAndTakeSnapshots} from '../../index';
import {scenario, testSetup, testTimeout} from './lib/E2ETestSettings';
import SnapshotResultReader from '../../result-reader/SnapshotResultReader';

beforeEach(testSetup);

function inject() {
  // @ts-ignore
  window.injectHookForLink4 = () => {
    const arr = [];
    for (let i = 0; i < 10000; ++i) {
      arr.push('duplicated string value' + (i % 1));
    }
    // @ts-ignore
    window.__injectedValue = arr;
  };
}

function checkResultReader(result: BrowserInteractionResultReader): void {
  const workDir = result.getRootDirectory();
  expect(fs.existsSync(workDir)).toBe(true);

  const snapshotDir = result.getSnapshotFileDir();
  expect(fs.existsSync(snapshotDir)).toBe(true);

  const snapshotFiles = result.getSnapshotFiles();
  expect(snapshotFiles.length > 0).toBe(true);

  const steps = result.getInteractionSteps();
  expect(steps.length > 0).toBe(true);
  expect(steps[0].name).toBe('page-load');

  const runMeta = result.getRunMetaInfo();
  expect(runMeta.app).toBe('test-spa');

  result.cleanup();
  expect(fs.existsSync(workDir)).toBe(false);
  expect(() => result.getRootDirectory()).toThrowError();
  expect(() => result.getSnapshotFileDir()).toThrowError();
  expect(() => result.getSnapshotFiles()).toThrowError();
}

test(
  'result data/file reader is working as expected',
  async () => {
    const result = await warmupAndTakeSnapshots({
      scenario,
      evalInBrowserAfterInitLoad: inject,
    });
    checkResultReader(result);
  },
  testTimeout,
);

test(
  'ResultReader.from is working as expected',
  async () => {
    const result = await warmupAndTakeSnapshots({
      scenario,
      evalInBrowserAfterInitLoad: inject,
    });
    checkResultReader(
      BrowserInteractionResultReader.from(result.getRootDirectory()),
    );
  },
  testTimeout,
);

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
  'SnapshotResultReader is working as expected',
  async () => {
    const result = await warmupAndTakeSnapshots({
      scenario,
      evalInBrowserAfterInitLoad: injectDetachedDOMElements,
    });
    const snapshotFiles = result.getSnapshotFiles();
    expect(snapshotFiles.length).toBe(3);
    const reader = SnapshotResultReader.fromSnapshots(
      snapshotFiles[0],
      snapshotFiles[1],
      snapshotFiles[2],
    );
    const leaks = await findLeaks(reader);
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
