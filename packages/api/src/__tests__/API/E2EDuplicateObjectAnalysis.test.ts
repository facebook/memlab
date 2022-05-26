/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */

import path from 'path';
import {ObjectShallowAnalysis, run} from '../../index';
import {scenario, testSetup, testTimeout} from './lib/E2ETestSettings';

beforeEach(testSetup);

function inject() {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  window.injectHookForLink4 = () => {
    const arr = [];
    for (let i = 0; i < 12345; ++i) {
      arr.push({v: i % 1});
    }
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    window.__injectedValue = arr;
  };
}

test(
  'Duplicate object analysis works as expected',
  async () => {
    const result = await run({scenario, evalInBrowserAfterInitLoad: inject});
    // test analysis from auto loading
    let analysis = new ObjectShallowAnalysis();
    await analysis.run();
    let dupcatedObjectInfo = analysis.getTopDuplicatedObjectInCount();
    expect(dupcatedObjectInfo[0].n).toBe(12345);

    // test analysis from file
    const snapshotFile = path.join(result.config.curDataDir, 's3.heapsnapshot');
    analysis = new ObjectShallowAnalysis();
    await analysis.analyzeSnapshotFromFile(snapshotFile);

    dupcatedObjectInfo = analysis.getTopDuplicatedObjectInCount();
    expect(dupcatedObjectInfo[0].n).toBe(12345);
  },
  testTimeout,
);
