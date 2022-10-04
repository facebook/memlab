/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {IHeapSnapshot} from '@memlab/core';
import {takeNodeMinimalHeap} from '@memlab/core';

class TestObject {
  public arr1 = [1, 2, 3];
  public arr2 = ['1', '2', '3'];
}

(async function () {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const obj = new TestObject();
  // get a heap snapshot of the current program state
  const heap: IHeapSnapshot = await takeNodeMinimalHeap();

  const node = heap.getAnyObjectWithClassName('TestObject');
  console.log(node?.name);
})();
