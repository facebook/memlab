/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import {ObjectShallowAnalysis, warmupAndTakeSnapshots} from '../../index';
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
    const result = await warmupAndTakeSnapshots({
      scenario,
      evalInBrowserAfterInitLoad: inject,
    });
    // test analysis from auto loading
    let analysis = new ObjectShallowAnalysis();
    await analysis.run();
    let dupcatedObjectInfo = analysis.getTopDuplicatedObjectInCount();
    expect(dupcatedObjectInfo[0].n).toBe(12345);

    // test analysis from file
    const snapshotFile = result.getSnapshotFiles().pop() as string;
    analysis = new ObjectShallowAnalysis();
    await analysis.analyzeSnapshotFromFile(snapshotFile);

    dupcatedObjectInfo = analysis.getTopDuplicatedObjectInCount();
    expect(dupcatedObjectInfo[0].n).toBe(12345);
  },
  testTimeout,
);
