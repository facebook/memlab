/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall mitigation_infra
 */

import type {IHeapSnapshot, Optional, IHeapConfig} from '@memlab/core';
import {config} from '@memlab/core';

class HeapConfig implements IHeapConfig {
  public isCliInteractiveMode = false;
  public currentHeapFile: Optional<string>;
  public currentHeap: Optional<IHeapSnapshot>;

  private constructor() {
    this.currentHeap = null;
    this.currentHeapFile = null;
  }

  private static instance: Optional<HeapConfig> = null;
  public static getInstance(): HeapConfig {
    if (!HeapConfig.instance) {
      HeapConfig.instance = new HeapConfig();
    }
    return HeapConfig.instance;
  }
}

const heapConfig = HeapConfig.getInstance();
config.heapConfig = heapConfig;
export default heapConfig;
