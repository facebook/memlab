/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import fs from 'fs';
import {z} from 'zod';
import {
  getCurrentHandle,
  listSnapshots,
  resolveHandle,
  pinHandle,
  restoreCurrentHandle,
  setCurrentSnapshot,
  unpinHandle,
} from './heap-state.js';
import {withSnapshotAt} from './snapshot-borrow.js';
import {resolveSnapshotPath} from './tools/load-snapshot.js';

/**
 * Stateless addressing: every single-snapshot tool takes an optional
 * `snapshot`, a resident handle or a `.heapsnapshot` path, and runs against it
 * without moving the session's active snapshot.
 *
 * Without it, a tool always reads the ACTIVE snapshot, so comparing two
 * captures meant `memlab_snapshots({action: "switch"})` between calls — and
 * forgetting one switch silently answered the question about the wrong
 * capture, with node ids that do not exist in the one meant.
 */

/** Tools that take several snapshots or manage the session themselves. */
const MULTI_SNAPSHOT_KEYS = [
  'paths',
  'run_dir',
  'before',
  'after',
  'baseline',
  'target',
  'baseline_handle',
  'target_handle',
  'handles',
  'file_path',
  'ladder',
  'snapshot',
];
const SESSION_TOOLS = new Set([
  'memlab_snapshots',
  'memlab_server_status',
  'memlab_tools',
  'memlab_job_status',
  'memlab_batch',
  'memlab_start_job',
]);

export function takesSnapshotParam(
  name: string,
  shape: Record<string, unknown>,
): boolean {
  if (SESSION_TOOLS.has(name)) return false;
  return !MULTI_SNAPSHOT_KEYS.some(k => k in shape);
}

export function snapshotParam() {
  return z
    .string()
    .optional()
    .describe(
      'Run against this snapshot instead of the active one: a resident handle, or a .heapsnapshot path (loaded for this call only, then released). The active snapshot is not changed.',
    );
}

/** Run `fn` with `ref` as the active snapshot, then restore the session. */
export async function withSnapshotRef<T>(
  ref: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const handle = resolveHandle(ref);
  if (handle != null) {
    const previous = getCurrentHandle();
    pinHandle(previous);
    setCurrentSnapshot(handle);
    try {
      return await fn();
    } finally {
      restoreCurrentHandle(previous);
      unpinHandle(previous);
    }
  }
  const {localPath} = resolveSnapshotPath(ref);
  if (!fs.existsSync(localPath)) {
    const handles = listSnapshots().map(m => m.handle);
    throw new Error(
      `\`snapshot: "${ref}"\` is neither a resident handle` +
        (handles.length > 0 ? ` (${handles.join(', ')})` : '') +
        ' nor a readable .heapsnapshot path.',
    );
  }
  return withSnapshotAt(localPath, () => fn());
}
