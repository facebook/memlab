/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
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
