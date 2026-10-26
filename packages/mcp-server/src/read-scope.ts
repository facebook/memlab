/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * Which snapshot FILES the current tool call has read.
 *
 * A tool result's "> Snapshot: …" header used to describe whatever snapshot
 * was resident when the result was built. For a tool that walks a round by
 * `run_dir` or `paths`, that is the caller's active snapshot — often a rung of
 * an earlier round — not anything the tool measured. Every rung load goes
 * through `withSnapshotAt`, which records the file here, so `toolResult` can
 * name what was actually read without each of ~25 tools threading a header
 * through by hand.
 *
 * Scoped per call with AsyncLocalStorage: the guardrail wrapper opens a scope
 * for every tool call, and `memlab_analysis_battery` opens one per step, so a
 * battery step's header names that step's reads, not the battery's.
 */
import {AsyncLocalStorage} from 'node:async_hooks';

interface ReadScope {
  files: string[];
}

const scope = new AsyncLocalStorage<ReadScope>();

export function runWithReadScope<T>(fn: () => Promise<T>): Promise<T> {
  return scope.run({files: []}, fn);
}

/** Record that the current call read `filePath`. */
export function noteSnapshotRead(filePath: string): void {
  const store = scope.getStore();
  if (store == null) return;
  const name = labelFor(filePath);
  if (!store.files.includes(name)) store.files.push(name);
}

/**
 * The snapshot files read by the current call, sorted by name. A tool reads
 * rungs in whatever order it needs them (`memlab_settle_check` reads the busy
 * rung, then the settle rung, then the baseline); `rung_NN_…` names sort into
 * ladder order, so the header's first … last span reads oldest to newest.
 */
export function snapshotsReadInScope(): readonly string[] {
  const files = scope.getStore()?.files;
  return files == null ? [] : [...files].sort();
}

/**
 * `<round>/<file>` for a rung under `<round>/snapshots/`, else `<dir>/<file>`.
 * Every round names its rungs `rung_00_c0…`, so the bare file name cannot say
 * WHICH round a header describes, and that was the confusion to remove.
 */
function labelFor(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  const file = parts.pop() ?? filePath;
  let dir = parts.pop();
  if (dir === 'snapshots' && parts.length > 0) dir = parts.pop();
  return dir != null ? `${dir}/${file}` : file;
}
