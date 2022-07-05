/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */
import type {IHeapNode} from '@memlab/core';
import type {HeapAnalysisOptions} from '../index';

import {config, dumpNodeHeapSnapshot} from '@memlab/core';
import {
  getSnapshotFileForAnalysis,
  loadHeapSnapshot,
  BaseAnalysis,
  getHeapFromFile,
  getDominatorNodes,
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

test('getHeapFromFile works as expected', async () => {
  const heapFile = dumpNodeHeapSnapshot();
  const heap = await getHeapFromFile(heapFile);
  expect(heap.nodes.length > 0).toBe(true);
});

test('getDominatorNodes works as expected', async () => {
  class TestObject {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const t1 = new TestObject();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const t2 = new TestObject();

  // dump the heap of this running JavaScript program
  const heapFile = dumpNodeHeapSnapshot();
  const heap = await getHeapFromFile(heapFile);

  // find the heap node for TestObject
  const nodes: IHeapNode[] = [];
  heap.nodes.forEach(node => {
    if (node.name === 'TestObject' && node.type === 'object') {
      nodes.push(node);
    }
  });

  // get the dominator nodes
  const dominatorIds = getDominatorNodes(
    new Set(nodes.map(node => node.id)),
    heap,
  );
  expect(dominatorIds.size).toBeGreaterThan(0);
});
