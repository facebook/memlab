/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import {IHeapSnapshot, Optional} from '@memlab/core';

class HeapConfig {
  public isCliInteractiveMode = false;
  public currentHeapFile: Optional<string>;
  public currentHeap: Optional<IHeapSnapshot>;
}

const heapConfig = new HeapConfig();
export default heapConfig;
