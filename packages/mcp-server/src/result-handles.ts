/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {
  getCurrentHandle,
  getSavedResult,
  listSavedResults,
} from './heap-state.js';

/**
 * Read a saved result (from `memlab_eval`'s `save_as` / `helpers.save`) as a
 * node-id list, so one tool's output can feed another's input without the ids
 * making a round trip through the transcript.
 *
 * A list of a few thousand ids is tens of thousands of tokens to print and
 * re-type, and re-typing them is where they get truncated or corrupted.
 *
 * Reads the SESSION REGISTRY, which is where both `save_as` and `helpers.save`
 * write (`setSavedResult`). It used to read `memlab_eval`'s per-snapshot scratch
 * under a `__saved:` prefix instead, which nothing has written for some time, so
 * `from_result` answered "nothing is saved" for a set that had just been saved.
 * The scratch is not consulted as a fallback: it also holds eval's own memoized
 * indexes under bare names, and it carries no record of which snapshot a value
 * belongs to, so reading it would mean either resolving an internal index as a
 * node-id list or stamping a value with a handle nobody verified.
 *
 * Accepts the shapes a result realistically has: an array of numbers, an array
 * of `{id}` objects, or an object with an `ids`/`node_ids` array.
 */
export function resolveSavedNodeIds(name: string): number[] {
  const currentHandle = getCurrentHandle();
  const saved = getSavedResult(name);
  if (saved == null) {
    // Names saved against ANOTHER snapshot are listed too, marked — suggesting
    // one that will then be refused for a handle mismatch is worse than saying
    // up front that it exists but belongs elsewhere.
    const available = listSavedResults().map(r =>
      currentHandle != null && r.handle !== currentHandle
        ? `${r.name} (saved against "${r.handle}")`
        : r.name,
    );
    throw new Error(
      `No saved result named "${name}". ` +
        (available.length > 0
          ? `Saved: ${available.join(', ')}.`
          : 'Nothing is saved. Save one with memlab_eval({code, save_as: "name"}) or helpers.save(name, ids).'),
    );
  }
  if (currentHandle != null && saved.handle !== currentHandle) {
    // Node ids are per-capture, so ids saved against another snapshot resolve
    // to unrelated objects rather than to nothing — a silently wrong answer.
    // `helpers.load` refuses the same read; this is the tool-side twin of it.
    throw new Error(
      `Saved result "${name}" was saved against snapshot "${saved.handle}" and the current snapshot is ` +
        `"${currentHandle}". Node ids are per-capture, so they would resolve to unrelated objects here. ` +
        'Re-save the set against this snapshot.',
    );
  }
  const raw: unknown = saved.value;
  const fromArray = (arr: unknown[]): number[] => {
    const ids: number[] = [];
    for (const item of arr) {
      if (typeof item === 'number' && Number.isFinite(item)) {
        ids.push(item);
      } else if (item != null && typeof item === 'object' && 'id' in item) {
        const id = (item as {id?: unknown}).id;
        if (typeof id === 'number') ids.push(id);
      }
    }
    return ids;
  };
  let ids: number[] = [];
  if (Array.isArray(raw)) {
    ids = fromArray(raw);
  } else if (raw != null && typeof raw === 'object') {
    const obj = raw as {ids?: unknown; node_ids?: unknown};
    const arr = Array.isArray(obj.ids)
      ? obj.ids
      : Array.isArray(obj.node_ids)
        ? obj.node_ids
        : null;
    if (arr != null) ids = fromArray(arr);
  }
  if (ids.length === 0) {
    throw new Error(
      `Saved result "${name}" holds no node ids. Expected an array of ids, an array of objects with an \`id\` field, or an object with an \`ids\` array.`,
    );
  }
  return ids;
}
