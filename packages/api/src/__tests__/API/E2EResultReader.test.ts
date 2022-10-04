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

import fs from 'fs';
import BrowserInteractionResultReader from '../../result-reader/BrowserInteractionResultReader';
import {warmupAndTakeSnapshots} from '../../index';
import {scenario, testSetup, testTimeout} from './lib/E2ETestSettings';

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
