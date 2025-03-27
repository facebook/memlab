/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapSnapshot, AnyValue} from '@memlab/core';
import {config, takeNodeMinimalHeap, tagObject} from '@memlab/core';

test('memory test', async () => {
  config.muteConsole = true;
  const o1: AnyValue = {};
  let o2: AnyValue = {};
  // tag o1 with marker: "memlab-mark-1"
  tagObject(o1, 'memlab-mark-1');
  // tag o2 with marker: "memlab-mark-2"
  tagObject(o2, 'memlab-mark-2');
  o2 = null;
  const heap: IHeapSnapshot = await takeNodeMinimalHeap();

  // expect object with marker "memlab-mark-1" exists
  expect(heap.hasObjectWithTag('memlab-mark-1')).toBe(true);

  // expect object with marker "memlab-mark-2" can be GCed
  expect(heap.hasObjectWithTag('memlab-mark-2')).toBe(false);
}, 60000);
