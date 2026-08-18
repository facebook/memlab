/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {getEvalScratch} from './heap-state.js';

/**
 * Per-value string duplication stats: how many copies, what they cost, and a
 * bounded sample of node ids to follow up on.
 */
export interface StringDupStats {
  count: number;
  totalSize: number;
  exampleIds: number[];
  /**
   * Copies reachable ONLY through a dev/automation root. -1 when the index was
   * built without the dev-root pass (see {@link buildStringIndex}).
   */
  devOnlyCount: number;
}

export interface StringIndex {
  byValue: Map<string, StringDupStats>;
  /** True when `devOnlyCount` is populated. */
  hasDevOnly: boolean;
  concatStringCount: number;
  concatStringSize: number;
}

// Bounded so the index cannot grow with instance count; 20 is what the
// deepest consumer (intern_opportunities' referrer sampling) needs.
const MAX_EXAMPLE_IDS = 20;

const CACHE_KEY = '__memlabStringIndex';

/**
 * Build (or reuse) the per-value string duplication index for a snapshot.
 *
 * `memlab_duplicated_strings` and `memlab_intern_opportunities` were each doing
 * their own full pass over every string node to build the same value → {count,
 * size, ids} map, and both are commonly run back to back on the same snapshot —
 * so the second one re-walked millions of nodes to recompute what the first had
 * already produced. The scan is cached in the per-snapshot eval scratch, which
 * already has exactly the lifecycle this needs: keyed by the active handle, and
 * dropped when that snapshot is replaced or unloaded, so a stale index can never
 * outlive the graph its node ids refer to.
 *
 * `withDevOnly` gates the dev/automation reachability pass, which is a whole-
 * graph walk that only `intern_opportunities` needs. A cached index built
 * without it is UPGRADED (rebuilt once) rather than silently returned, since
 * `devOnlyCount: -1` would otherwise be read as "no dev-only copies".
 */
export function buildStringIndex(
  snapshot: IHeapSnapshot,
  opts: {
    withDevOnly?: boolean;
    isDevOnlyNode?: (node: IHeapNode) => boolean;
  } = {},
): StringIndex {
  const scratch = getEvalScratch();
  const cached = scratch[CACHE_KEY] as StringIndex | undefined;
  const wantDevOnly = opts.withDevOnly === true;
  // `withDevOnly` without an `isDevOnlyNode` is a programmer error, not a
  // degraded mode: without the predicate the pass cannot run, so the index
  // would be built with `hasDevOnly: false`, fail the cache-reuse guard below,
  // and be rebuilt in full on every call. Refuse instead of silently
  // re-scanning the whole graph forever.
  if (wantDevOnly && opts.isDevOnlyNode == null) {
    throw new Error(
      'buildStringIndex: withDevOnly requires isDevOnlyNode; without it the dev-root pass cannot run.',
    );
  }
  if (cached && (!wantDevOnly || cached.hasDevOnly)) {
    return cached;
  }

  const isDevOnly = wantDevOnly ? opts.isDevOnlyNode : undefined;
  const byValue = new Map<string, StringDupStats>();
  let concatStringCount = 0;
  let concatStringSize = 0;

  snapshot.nodes.forEach(node => {
    if (node.name === '(concatenated string)') {
      concatStringCount++;
      concatStringSize += node.self_size;
    }
    if (node.type !== 'string') return;
    // Sliced strings share a parent's storage, so they are not independent
    // duplicates and counting them would overstate any interning win.
    if (node.name === 'system / SlicedString') return;
    const strNode = node.toStringNode();
    if (!strNode) return;
    const value = strNode.stringValue;
    const devOnly = isDevOnly != null && isDevOnly(node);
    const entry = byValue.get(value);
    if (entry) {
      entry.count++;
      entry.totalSize += node.retainedSize;
      if (devOnly) entry.devOnlyCount++;
      if (entry.exampleIds.length < MAX_EXAMPLE_IDS) {
        entry.exampleIds.push(node.id);
      }
    } else {
      byValue.set(value, {
        count: 1,
        totalSize: node.retainedSize,
        exampleIds: [node.id],
        devOnlyCount: isDevOnly == null ? -1 : devOnly ? 1 : 0,
      });
    }
  });

  const index: StringIndex = {
    byValue,
    hasDevOnly: isDevOnly != null,
    concatStringCount,
    concatStringSize,
  };
  scratch[CACHE_KEY] = index;
  return index;
}

/** True when this snapshot's string index is already built and resident. */
export function stringIndexIsCached(): boolean {
  return getEvalScratch()[CACHE_KEY] != null;
}
