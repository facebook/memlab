/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapSnapshot} from '@memlab/core';

let currentSnapshot: IHeapSnapshot | null = null;
let currentFilePath: string | null = null;

export function getSnapshot(): IHeapSnapshot {
  if (!currentSnapshot) {
    throw new Error('No heap snapshot loaded. Use memlab_load_snapshot first.');
  }
  return currentSnapshot;
}

export function getFilePath(): string | null {
  return currentFilePath;
}

export function setSnapshot(snapshot: IHeapSnapshot, filePath: string): void {
  currentSnapshot = snapshot;
  currentFilePath = filePath;
}
