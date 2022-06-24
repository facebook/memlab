/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import {config} from '@memlab/core';
import heapAnalysisLoader from '../HeapAnalysisLoader';

beforeEach(() => {
  config.isTest = true;
});

test('Heap analysis modules can be loaded', async () => {
  const heapAnalysisMap = heapAnalysisLoader.loadAllAnalysis();
  expect(heapAnalysisMap.size).toBeGreaterThan(0);
});
