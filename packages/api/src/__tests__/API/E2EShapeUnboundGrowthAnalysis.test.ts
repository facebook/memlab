/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
/* eslint-disable @typescript-eslint/ban-ts-comment */

import path from 'path';
import {ShapeUnboundGrowthAnalysis, run} from '../../index';
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
    const result = await run({
      scenario: repeatScenario,
      evalInBrowserAfterInitLoad: inject,
      snapshotForEachStep: true,
    });
    // test analysis from auto loading
    let analysis = new ShapeUnboundGrowthAnalysis();
    let shapeSummary = await analysis.run();
    expect(
      shapeSummary.reduce(
        (acc: boolean, summary: ShapeSummary) =>
          acc || summary.shape.includes('LeakObject'),
        false,
      ),
    ).toBe(true);

    // test analysis from file
    const snapshotDir = path.join(result.config.curDataDir);
    analysis = new ShapeUnboundGrowthAnalysis();
    shapeSummary = await analysis.analyzeSnapshotsInDirectory(snapshotDir);
    expect(
      shapeSummary.some((summary: ShapeSummary) =>
        summary.shape.includes('LeakObject'),
      ),
    ).toBe(true);

    // expect incorrect use of heap analysis to throw
    const snapshotFile = path.join(result.config.curDataDir, 's3.heapsnapshot');
    analysis = new ShapeUnboundGrowthAnalysis();
    let isThrow = false;
    try {
      await analysis.analyzeSnapshotFromFile(snapshotFile);
    } catch (ex) {
      isThrow = true;
    }
    expect(isThrow).toBe(true);
  },
  testTimeout,
);
