/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {IHeapSnapshot} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const object = {'memlab-test-heap-property': 'memlab-test-heap-value'};

  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getHeapFromFile(heapFile);

  // should be true
  console.log(heap.hasObjectWithPropertyName('memlab-test-heap-property'));
})();
