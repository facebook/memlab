/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

/* eslint-disable @typescript-eslint/ban-ts-comment */

import type {Page} from 'puppeteer';
import type {IScenario} from '@memlab/core';
import type {HeapAnalysisOptions} from '@memlab/heap-analysis';

import {snapshotMapReduce, BaseAnalysis} from '@memlab/heap-analysis';
import {analyze} from '../../index';
import {testSetup, testTimeout} from '../API/lib/E2ETestSettings';
import {takeSnapshots} from '../../API';

beforeEach(testSetup);

function injectTestObject() {
  class TestObject {}
  // @ts-ignore
  window.injectHookForLink4 = () => {
    // @ts-ignore
    const arr = (window.__injectedValue = window.__injectedValue || []);
    arr.push(new TestObject());
  };
}

const selfDefinedScenario: IScenario = {
  app: (): string => 'test-spa',
  url: (): string => '',
  action: async (page: Page): Promise<void> =>
    await page.click('[data-testid="link-4"]'),
  repeat: () => 3,
};

class ExampleAnalysis extends BaseAnalysis {
  public isMonotonicIncreasing = false;
  public getCommandName(): string {
    return 'example-analysis';
  }

  public getDescription(): string {
    return 'an example analysis for demo';
  }

  async process(options: HeapAnalysisOptions): Promise<void> {
    // check if the number of TestObject keeps growing overtime
    this.isMonotonicIncreasing = await snapshotMapReduce(
      heap => {
        let cnt = 0;
        heap.nodes.forEach(node => {
          if (node.name === 'TestObject' && node.type === 'object') {
            ++cnt;
          }
        });
        return cnt;
      },
      nodeCounts =>
        nodeCounts[0] === 0 &&
        nodeCounts[nodeCounts.length - 1] === 4 &&
        nodeCounts.every((count, i) => i === 0 || count >= nodeCounts[i - 1]),
      options,
    );
  }
}

test(
  'snapshotMapReduce works as expected',
  async () => {
    const results = await takeSnapshots({
      scenario: selfDefinedScenario,
      evalInBrowserAfterInitLoad: injectTestObject,
      snapshotForEachStep: true,
    });

    let analysis = new ExampleAnalysis();
    await analyze(results, analysis);
    expect(analysis.isMonotonicIncreasing).toBe(true);

    analysis = new ExampleAnalysis();
    await analysis.analyzeSnapshotsInDirectory(results.getSnapshotFileDir());
    expect(analysis.isMonotonicIncreasing).toBe(true);
  },
  testTimeout,
);
