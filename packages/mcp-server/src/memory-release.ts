/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import v8 from 'v8';
import vm from 'vm';

/**
 * Hand a dropped snapshot's memory back right away.
 *
 * A parsed snapshot is a few large typed arrays plus millions of small
 * objects. Once its handle is gone, V8 frees them only at its next major GC,
 * and until then the process holds the whole snapshot: unloading a 924 MB
 * capture left the server at 3.1 GB. Ladder tools load and drop one rung
 * after another, so the dead rungs could stack up before the collector ran.
 */

type GcFn = () => void;
let gcFn: GcFn | null | undefined;

function getGc(): GcFn | null {
  if (gcFn !== undefined) return gcFn;
  const exposed = (globalThis as {gc?: GcFn}).gc;
  if (typeof exposed === 'function') {
    gcFn = exposed;
    return gcFn;
  }
  try {
    // Without --expose-gc on the command line: enable the flag, then read
    // `gc` from a fresh context, which is created after the flag is set.
    v8.setFlagsFromString('--expose-gc');
    const fn = vm.runInNewContext('gc') as unknown;
    gcFn = typeof fn === 'function' ? (fn as GcFn) : null;
  } catch {
    gcFn = null;
  }
  return gcFn;
}

export interface MemoryRelease {
  collected: boolean;
  rssBefore: number;
  rssAfter: number;
  heapBefore: number;
  heapAfter: number;
}

/**
 * Run a full GC now, and report process memory before and after. `passes: 2`
 * also collects what the first pass's finalizers released; the ladder path
 * between rungs uses one, so it pays a single pause per rung.
 */
export function releaseMemory(passes: 1 | 2 = 2): MemoryRelease {
  const before = process.memoryUsage();
  const gc = getGc();
  if (gc != null) {
    for (let i = 0; i < passes; i++) gc();
  }
  const after = process.memoryUsage();
  return {
    collected: gc != null,
    rssBefore: before.rss,
    rssAfter: after.rss,
    heapBefore: before.heapUsed + before.external,
    heapAfter: after.heapUsed + after.external,
  };
}
