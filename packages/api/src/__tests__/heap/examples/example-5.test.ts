/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapSnapshot, Nullable} from '@memlab/core';
import {config, takeNodeMinimalHeap} from '@memlab/core';

class TestObject {
  public arr1 = [1, 2, 3];
  public arr2 = ['1', '2', '3'];
}

test('memory test', async () => {
  config.muteConsole = true;
  let obj: Nullable<TestObject> = new TestObject();
  // get a heap snapshot of the current program state
  let heap: IHeapSnapshot = await takeNodeMinimalHeap();

  // call some function that may add references to obj
  // rabbitHole()

  expect(heap.hasObjectWithClassName('TestObject')).toBe(true);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  obj = null;

  heap = await takeNodeMinimalHeap();
  // if rabbitHole does not add new references, the obj can be GCed
  expect(heap.hasObjectWithClassName('TestObject')).toBe(false);
}, 60000);
