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

import {ShapeUnboundGrowthAnalysis, warmupAndTakeSnapshots} from '../../index';
import {scenario, testSetup, testTimeout} from './lib/E2ETestSettings';

beforeEach(testSetup);

type ShapeSummary = {
  shape: string;
};

function inject() {
  // @ts-ignore
  window.injectHookForLink4 = () => {
    function LeakObject() {
      // @ts-ignore
      this.value = `value: ${Math.random()}`;
    }
    // @ts-ignore
    const leak = (window.__injectedValue = window.__injectedValue || []);
    for (let i = 0; i < 10000; ++i) {
      // @ts-ignore
      leak.push(new LeakObject());
    }
  };
}

test(
  'Shape unbound analysis works as expected',
  async () => {
    const repeatScenario = {repeat: () => 2, ...scenario};
    // test analysis from auto loading
    const result = await warmupAndTakeSnapshots({
      scenario: repeatScenario,
      evalInBrowserAfterInitLoad: inject,
      snapshotForEachStep: true,
    });
    // test analysis from auto loading
    let analysis = new ShapeUnboundGrowthAnalysis();
    await analysis.run();
    let shapeSummary = analysis.getShapesWithUnboundGrowth();
    expect(
      shapeSummary.reduce(
        (acc: boolean, summary: ShapeSummary) =>
          acc || summary.shape.includes('LeakObject'),
        false,
      ),
    ).toBe(true);

    // test analysis from file
    const snapshotDir = result.getSnapshotFileDir();
    analysis = new ShapeUnboundGrowthAnalysis();
    await analysis.analyzeSnapshotsInDirectory(snapshotDir);
    shapeSummary = analysis.getShapesWithUnboundGrowth();
    expect(
      shapeSummary.some((summary: ShapeSummary) =>
        summary.shape.includes('LeakObject'),
      ),
    ).toBe(true);

    // expect incorrect use of heap analysis to throw
    const snapshotFile = result.getSnapshotFiles().pop() as string;
    analysis = new ShapeUnboundGrowthAnalysis();
    expect(
      async () => await analysis.analyzeSnapshotFromFile(snapshotFile),
    ).rejects.toThrowError();
  },
  testTimeout,
);
