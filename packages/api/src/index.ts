/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import path from 'path';
import {PackageInfoLoader} from '@memlab/core';
/** @internal */
export async function registerPackage(): Promise<void> {
  return PackageInfoLoader.registerPackage(path.join(__dirname, '..'));
}

export * from './API';
export * from '@memlab/heap-analysis';
export * from './state/ConsoleModeManager';
export {default as BrowserInteractionResultReader} from './result-reader/BrowserInteractionResultReader';
export {default as SnapshotResultReader} from './result-reader/SnapshotResultReader';
export {
  dumpNodeHeapSnapshot,
  getNodeInnocentHeap,
  takeNodeMinimalHeap,
} from '@memlab/core';
/** @internal */
export {config} from '@memlab/core';
