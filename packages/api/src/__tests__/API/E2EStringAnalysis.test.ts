/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

/* eslint-disable @typescript-eslint/ban-ts-comment */

import path from 'path';
import {StringAnalysis, run} from '../../index';
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

test(
  'String analysis works as expected',
  async () => {
    const result = await run({scenario, evalInBrowserAfterInitLoad: inject});
    // test analysis from auto loading
    let analysis = new StringAnalysis();
    await analysis.run();
    let dupStrings = analysis.getTopDuplicatedStringsInCount();
    expect(dupStrings[0].n).toBe(10000);
    expect(dupStrings[0].str).toBe('duplicated string value0');

    // test analysis from file
    const snapshotFile = path.join(result.config.curDataDir, 's3.heapsnapshot');
    analysis = new StringAnalysis();
    await analysis.analyzeSnapshotFromFile(snapshotFile);

    dupStrings = analysis.getTopDuplicatedStringsInCount();
    expect(dupStrings[0].n).toBe(10000);
    expect(dupStrings[0].str).toBe('duplicated string value0');

    // expect incorrect use of heap analysis to throw
    const snapshotDir = result.config.curDataDir;
    analysis = new StringAnalysis();
    let isThrow = false;
    try {
      await analysis.analyzeSnapshotsInDirectory(snapshotDir);
    } catch (ex) {
      isThrow = true;
    }
    expect(isThrow).toBe(true);
  },
  testTimeout,
);
