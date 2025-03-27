/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type {BrowserInteractionResultReader} from '../../index';

import fs from 'fs';
import path from 'path';
import {ObjectShallowAnalysis, warmupAndTakeSnapshots} from '../../index';
import {
  scenario,
  testSetup,
  testTimeout,
  getUniqueID,
} from './lib/E2ETestSettings';

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

async function gatherSnapshots(): Promise<BrowserInteractionResultReader> {
  const result = await warmupAndTakeSnapshots({
    scenario,
    evalInBrowserAfterInitLoad: inject,
  });
  return result;
}

async function testAnalysisFromAutoLoading(): Promise<void> {
  // test analysis from auto loading
  const analysis = new ObjectShallowAnalysis();
  await analysis.run();
  const dupcatedObjectInfo = analysis.getTopDuplicatedObjectInCount();
  expect(dupcatedObjectInfo[0].n).toBe(12345);
}

async function testAnalysisFromFileDir(
  result: BrowserInteractionResultReader,
): Promise<void> {
  // test analysis from file
  const snapshotFile = result.getSnapshotFiles().pop() as string;
  const analysis = new ObjectShallowAnalysis();
  await analysis.analyzeSnapshotFromFile(snapshotFile);

  const dupcatedObjectInfo = analysis.getTopDuplicatedObjectInCount();
  expect(dupcatedObjectInfo[0].n).toBe(12345);
}

async function testAnalysisWithSpecifiedWorkDir(
  result: BrowserInteractionResultReader,
): Promise<void> {
  const snapshotFile = result.getSnapshotFiles().pop() as string;
  const analysis = new ObjectShallowAnalysis();
  const workDir = `/tmp/memlab-test/${getUniqueID()}`;
  const ret = await analysis.analyzeSnapshotFromFile(snapshotFile, {workDir});
  // expect the heap analysis output log file to exist and
  expect(fs.existsSync(ret.analysisOutputFile)).toBe(true);
  // output file is inside the working directory
  expect(
    path.resolve(ret.analysisOutputFile).includes(path.resolve(workDir)),
  ).toBe(true);

  const dupcatedObjectInfo = analysis.getTopDuplicatedObjectInCount();
  expect(dupcatedObjectInfo[0].n).toBe(12345);
}

test(
  'Duplicate object analysis works as expected',
  async () => {
    const result = await gatherSnapshots();
    await testAnalysisFromAutoLoading();
    await testAnalysisFromFileDir(result);
    await testAnalysisWithSpecifiedWorkDir(result);
  },
  testTimeout,
);
