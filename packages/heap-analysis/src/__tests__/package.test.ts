/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {HeapAnalysisOptions} from '../index';

import {config, dumpNodeHeapSnapshot} from '@memlab/core';
import {
  getSnapshotFileForAnalysis,
  loadHeapSnapshot,
  BaseAnalysis,
} from '../index';

beforeEach(() => {
  config.isTest = true;
});

test('loadHeapSnapshot works as expected', async () => {
  let called = false;
  class ExampleAnalysis extends BaseAnalysis {
    public getCommandName(): string {
      return 'example-analysis';
    }

    public getDescription(): string {
      return 'an example analysis for demo';
    }

    async process(options: HeapAnalysisOptions): Promise<void> {
      const heap = await loadHeapSnapshot(options);
      called = true;
      expect(heap.nodes.length > 0).toBe(true);
    }
  }

  const analysis = new ExampleAnalysis();
  await analysis.analyzeSnapshotFromFile(dumpNodeHeapSnapshot());
  expect(called).toBe(true);
});

test('analyzeSnapshotFromFile works as expected', async () => {
  let called = false;
  const heapFile = dumpNodeHeapSnapshot();
  class ExampleAnalysis extends BaseAnalysis {
    public getCommandName(): string {
      return 'example-analysis';
    }

    public getDescription(): string {
      return 'an example analysis for demo';
    }

    async process(options: HeapAnalysisOptions): Promise<void> {
      const file = getSnapshotFileForAnalysis(options);
      called = true;
      expect(file).toBe(heapFile);
    }
  }

  const analysis = new ExampleAnalysis();
  await analysis.analyzeSnapshotFromFile(heapFile);
  expect(called).toBe(true);
});
