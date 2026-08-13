/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {getEvalScratch} from './heap-state.js';

/**
 * Read a saved result (from `memlab_eval`'s `save_as` / `helpers.save`) as a
 * node-id list, so one tool's output can feed another's input without the ids
 * making a round trip through the transcript.
 *
 * A list of a few thousand ids is tens of thousands of tokens to print and
 * re-type, and re-typing them is where they get truncated or corrupted. The
 * scratch store already existed for `eval`; this makes it readable by the tools
 * that take `node_ids`, which is where such a list is actually wanted.
 *
 * Accepts the shapes a result realistically has: an array of numbers, an array
 * of `{id}` objects, or an object with an `ids`/`node_ids` array.
 */
// `memlab_eval` namespaces saved values in the shared per-snapshot scratch so
// they cannot collide with its own indexes. Reading them back means honoring
// that prefix — a bare-name lookup finds nothing and reports "not saved" for a
// result that is sitting right there.
const SAVED_PREFIX = '__saved:';

export function resolveSavedNodeIds(name: string): number[] {
  const scratch = getEvalScratch();
  const prefixed = SAVED_PREFIX + name;
  const key = prefixed in scratch ? prefixed : name;
  if (!(key in scratch)) {
    const available = Object.keys(scratch)
      .filter(k => k.startsWith(SAVED_PREFIX))
      .map(k => k.slice(SAVED_PREFIX.length));
    throw new Error(
      `No saved result named "${name}". ` +
        (available.length > 0
          ? `Saved: ${available.join(', ')}.`
          : 'Nothing is saved for this snapshot. Save one with memlab_eval({code, save_as: "name"}).') +
        ' Saved results are per-snapshot and are dropped when the snapshot is replaced.',
    );
  }
  const raw: unknown = scratch[key];
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
