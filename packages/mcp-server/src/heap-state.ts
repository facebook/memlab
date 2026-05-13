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

export type SnapshotEnv = 'browser' | 'node' | 'unknown';

export interface SnapshotMetadata {
  filePath: string;
  fileName: string;
  nodeCount: number;
  edgeCount: number;
  totalSize: number;
  env: SnapshotEnv;
}

let currentSnapshot: IHeapSnapshot | null = null;
let currentMetadata: SnapshotMetadata | null = null;

export function getSnapshot(): IHeapSnapshot {
  if (!currentSnapshot) {
    throw new Error('No heap snapshot loaded. Use memlab_load_snapshot first.');
  }
  return currentSnapshot;
}

export function getFilePath(): string | null {
  return currentMetadata?.filePath ?? null;
}

export function getSnapshotEnv(): SnapshotEnv {
  return currentMetadata?.env ?? 'unknown';
}

export function getSnapshotMetadata(): SnapshotMetadata | null {
  return currentMetadata;
}

export function setSnapshot(
  snapshot: IHeapSnapshot,
  filePath: string,
  metadata: Omit<SnapshotMetadata, 'filePath'>,
): void {
  currentSnapshot = snapshot;
  currentMetadata = {filePath, ...metadata};
}
