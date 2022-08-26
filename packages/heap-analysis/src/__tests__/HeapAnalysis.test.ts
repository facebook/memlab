/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import {config, IHeapSnapshot} from '@memlab/core';
import {takeNodeFullHeap} from '..';
import heapAnalysisLoader from '../HeapAnalysisLoader';

beforeEach(() => {
  config.isTest = true;
});

const timeout = 5 * 60 * 1000;

test(
  'Heap analysis modules can be loaded',
  async () => {
    const heapAnalysisMap = heapAnalysisLoader.loadAllAnalysis();
    expect(heapAnalysisMap.size).toBeGreaterThan(0);
  },
  timeout,
);

test(
  'takeNodeFullHeap works as expected',
  async () => {
    class TestClass {
      public name = 'test';
      public age = 183;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _v = new TestClass();
    const heap: IHeapSnapshot = await takeNodeFullHeap();
    const node = heap.getAnyObjectWithClassName('TestClass');
    expect(node?.dominatorNode != null).toBe(true);
    const size = node?.retainedSize ?? 0;
    expect(size > 0).toBe(true);
  },
  timeout,
);
