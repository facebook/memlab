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

import {BrowserInteractionResultReader} from '../../index';
import fs from 'fs';
import path from 'path';
import {ShapeUnboundGrowthAnalysis, warmupAndTakeSnapshots} from '../../index';
import {
  scenario,
  testSetup,
  testTimeout,
  getUniqueID,
} from './lib/E2ETestSettings';

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

async function gatherSnapshots(): Promise<BrowserInteractionResultReader> {
  const repeatScenario = {repeat: () => 2, ...scenario};
  // test analysis from auto loading
  const result = await warmupAndTakeSnapshots({
    scenario: repeatScenario,
    evalInBrowserAfterInitLoad: inject,
    snapshotForEachStep: true,
  });
  return result;
}

async function testAnalysisFromAutoLoading(): Promise<void> {
  // test analysis from auto loading
  const analysis = new ShapeUnboundGrowthAnalysis();
  await analysis.run();
  const shapeSummary = analysis.getShapesWithUnboundGrowth();
  expect(
    shapeSummary.reduce(
      (acc: boolean, summary: ShapeSummary) =>
        acc || summary.shape.includes('LeakObject'),
      false,
    ),
  ).toBe(true);
}

async function testAnalysisFromFileDir(
  result: BrowserInteractionResultReader,
): Promise<void> {
  // test analysis from file
  const snapshotDir = result.getSnapshotFileDir();
  const analysis = new ShapeUnboundGrowthAnalysis();
  const ret = await analysis.analyzeSnapshotsInDirectory(snapshotDir);

  // expect the heap analysis output log file to exist and
  // to contain the expected results
  expect(fs.existsSync(ret.analysisOutputFile)).toBe(true);
  expect(
    fs
      .readFileSync(ret.analysisOutputFile, {encoding: 'utf8'})
      .includes('LeakObject'),
  ).toBe(true);

  // expect the query API works
  const shapeSummary = analysis.getShapesWithUnboundGrowth();
  expect(
    shapeSummary.some((summary: ShapeSummary) =>
      summary.shape.includes('LeakObject'),
    ),
  ).toBe(true);
}

async function testIncorrectUseage(
  result: BrowserInteractionResultReader,
): Promise<void> {
  // expect incorrect use of heap analysis to throw
  const snapshotFile = result.getSnapshotFiles().pop() as string;
  const analysis = new ShapeUnboundGrowthAnalysis();
  expect(
    async () => await analysis.analyzeSnapshotFromFile(snapshotFile),
  ).rejects.toThrowError();
}

async function testAnalysisWithSpecifiedWorkDir(
  result: BrowserInteractionResultReader,
): Promise<void> {
  // test analysis from file
  const snapshotDir = result.getSnapshotFileDir();
  const analysis = new ShapeUnboundGrowthAnalysis();
  const workDir = `/tmp/memlab-test/${getUniqueID()}`;
  const ret = await analysis.analyzeSnapshotsInDirectory(snapshotDir, {
    workDir,
  });

  // expect the heap analysis output log file to exist and
  expect(fs.existsSync(ret.analysisOutputFile)).toBe(true);
  // output file is inside the working directory
  expect(
    path.resolve(ret.analysisOutputFile).includes(path.resolve(workDir)),
  ).toBe(true);
  // output file contains the expected result
  expect(
    fs
      .readFileSync(ret.analysisOutputFile, {encoding: 'utf8'})
      .includes('LeakObject'),
  ).toBe(true);

  // expect the query API works
  const shapeSummary = analysis.getShapesWithUnboundGrowth();
  expect(
    shapeSummary.some((summary: ShapeSummary) =>
      summary.shape.includes('LeakObject'),
    ),
  ).toBe(true);
}

test(
  'Shape unbound analysis works as expected',
  async () => {
    const result = await gatherSnapshots();
    await testAnalysisFromAutoLoading();
    await testAnalysisFromFileDir(result);
    await testIncorrectUseage(result);
    await testAnalysisWithSpecifiedWorkDir(result);
  },
  testTimeout,
);
