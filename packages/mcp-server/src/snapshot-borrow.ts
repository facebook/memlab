/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {timedLoad} from './perf-stats.js';
import {currentProgress} from './progress.js';
import {releaseMemory} from './memory-release.js';
import {detectEnv} from './tools/load-snapshot.js';
import type {IHeapSnapshot} from '@memlab/core';
import {AsyncLocalStorage} from 'node:async_hooks';
import fs from 'fs';
import os from 'os';
import memlabHeapAnalysis from '@memlab/heap-analysis';
const {getFullHeapFromFile} = memlabHeapAnalysis;
import {
  findResidentByPath,
  getCurrentHandle,
  pinHandle,
  getMetadataByHandle,
  getSnapshotByHandle,
  removeSnapshot,
  restoreCurrentHandle,
  setCurrentSnapshot,
  unpinHandle,
  setSnapshot,
} from './heap-state.js';
import {beginAnalysisBudget} from './analysis-budget.js';
import {
  estimateLoadHeapMB,
  getHeapHeadroomMB,
  resolveMaxFileSizeMB,
  resolveSnapshotPath,
} from './tools/load-snapshot.js';
import {noteSnapshotRead} from './read-scope.js';

/**
 * Rungs borrowed inside a retention scope stay resident after the borrow, so
 * the next tool that walks the same ladder reuses them instead of re-parsing.
 * A battery ran 6+ ladder tools over the same 5 rungs, and each one parsed
 * every rung again: about 30 parses of 400-500 MB files per round.
 */
interface RungRetention {
  /** Retained handles, least recently borrowed first. */
  handles: string[];
  parses: number;
  reuses: number;
  evicted: number;
}

const retentionStore = new AsyncLocalStorage<RungRetention>();

/** MEMLAB_RETAIN_RUNGS caps how many rungs a scope keeps (0 disables). */
function retainCap(): number {
  const raw = process.env.MEMLAB_RETAIN_RUNGS;
  const n = raw == null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 8;
}

/**
 * Room to load and analyse one more rung of this size, in old space and in
 * system memory (the graph's typed arrays live outside the V8 heap).
 */
function roomForAnother(snapshot: IHeapSnapshot): boolean {
  const needMB =
    2 *
    estimateLoadHeapMB(
      {
        nodeCount: snapshot.nodes?.length ?? 0,
        edgeCount: snapshot.edges?.length ?? 0,
      },
      false,
    );
  const heap = getHeapHeadroomMB();
  const freeMB = os.freemem() / (1024 * 1024);
  return (heap == null || heap >= needMB) && freeMB >= needMB;
}

export interface RungRetentionStats {
  parses: number;
  reuses: number;
  evicted: number;
}

/**
 * Run `fn` with borrowed rungs kept resident, within memory, until it ends.
 * Every rung still retained is dropped afterwards, except the active snapshot.
 */
export async function runWithRungRetention<T>(
  fn: () => Promise<T>,
): Promise<{result: T; stats: RungRetentionStats}> {
  const r: RungRetention = {handles: [], parses: 0, reuses: 0, evicted: 0};
  try {
    const result = await retentionStore.run(r, fn);
    return {
      result,
      stats: {parses: r.parses, reuses: r.reuses, evicted: r.evicted},
    };
  } finally {
    const current = getCurrentHandle();
    let dropped = 0;
    for (const h of r.handles) {
      if (h !== current && removeSnapshot(h)) dropped++;
    }
    r.handles.length = 0;
    if (dropped > 0) releaseMemory(1);
  }
}

/**
 * Keep a just-borrowed rung, evicting the oldest kept ones to make room.
 * `callerHandle` (the snapshot active before the borrow) is never evicted:
 * if it is a kept rung, the caller now owns it and it leaves the scope.
 */
function retain(
  r: RungRetention,
  handle: string,
  snapshot: IHeapSnapshot,
  callerHandle: string | null,
): boolean {
  const cap = retainCap();
  if (cap === 0) return false;
  // A replacing load elsewhere may have dropped kept rungs already.
  r.handles = r.handles.filter(h => getMetadataByHandle(h) != null);
  r.handles.push(handle);
  while (
    r.handles.length > 0 &&
    (r.handles.length > cap || !roomForAnother(snapshot))
  ) {
    const victim = r.handles.shift() as string;
    if (victim === callerHandle) continue;
    removeSnapshot(victim);
    r.evicted++;
    releaseMemory(1);
    if (victim === handle) return true;
  }
  return true;
}

/**
 * Run `fn` against the snapshot at `localPath`, loading it only if it is not
 * already resident, and leaving the session exactly as it was found.
 *
 * Every tool that walks an ORDERED ladder needs this, and each one getting it
 * subtly wrong is the failure mode worth designing out. Three invariants:
 *
 *  - **Reuse a resident graph.** Re-parsing a 250 MB capture that is already in
 *    memory is the single most expensive avoidable thing these tools do.
 *  - **Hold one graph at a time.** `memlab_eval_across` needs every rung
 *    resident simultaneously, which is precisely why it cannot serve a ladder of
 *    large captures. Loading and dropping keeps peak RSS at one rung.
 *  - **Restore the caller's active snapshot.** A ladder walk is a measurement,
 *    not a navigation; silently leaving the session pointed at rung 6 makes the
 *    caller's next `memlab_eval` answer a question about the wrong capture, and
 *    nothing in that output says so.
 */
export async function withSnapshotAt<T>(
  localPath: string,
  fn: (snapshot: IHeapSnapshot) => Promise<T> | T,
): Promise<T> {
  const resident = findResidentByPath(localPath);
  let snapshot: IHeapSnapshot | null =
    resident != null ? getSnapshotByHandle(resident.handle) : null;
  const previousHandle = getCurrentHandle();
  let temporaryHandle: string | null = null;
  pinHandle(previousHandle);

  const retention = retentionStore.getStore();
  if (
    retention != null &&
    resident != null &&
    retention.handles.includes(resident.handle)
  ) {
    retention.reuses++;
    // Most recently borrowed last, so eviction takes the coldest rung.
    retention.handles = [
      ...retention.handles.filter(h => h !== resident.handle),
      resident.handle,
    ];
  }
  try {
    if (snapshot == null) {
      if (retention != null) retention.parses++;
      const name = localPath.replace(/^.*\//, '');
      const started = Date.now();
      currentProgress().note?.(
        `loading ${name} (the parse and dominator pass block without further output)`,
      );
      snapshot = await timedLoad(localPath, 'temporary', () =>
        getFullHeapFromFile(localPath),
      );
      currentProgress().note?.(
        `loaded ${name} in ${Math.round((Date.now() - started) / 1000)}s`,
      );
      const meta = setSnapshot(
        snapshot,
        localPath,
        {
          fileName: localPath.replace(/^.*\//, ''),
          nodeCount: snapshot.nodes?.length ?? 0,
          edgeCount: snapshot.edges?.length ?? 0,
          // Node 0 is V8's synthetic root: it dominates every node, so its
          // retained size is the heap total.
          totalSize: snapshot.nodes?.get(0)?.retainedSize ?? 0,
          env: detectEnv(snapshot).env,
        },
        {replace: false},
      );
      temporaryHandle = meta.handle;
    } else if (resident != null) {
      setCurrentSnapshot(resident.handle);
    }
    // Only once the rung is loaded: a failed load was not read.
    noteSnapshotRead(localPath);
    return await fn(snapshot);
  } finally {
    // Retained: removed later by its scope (or evicted for room) instead.
    const kept =
      temporaryHandle != null &&
      retention != null &&
      snapshot != null &&
      retain(retention, temporaryHandle, snapshot, previousHandle);
    if (temporaryHandle != null && !kept) {
      removeSnapshot(temporaryHandle);
      // Ladder tools borrow one rung after another; free each before the next.
      // This frame's own reference has to go first, or the GC keeps the rung.
      snapshot = null;
      releaseMemory(1);
    }
    // Same restore as a borrowed handle: back to the saved snapshot, or, if
    // it was unloaded meanwhile, a fallback that the next result announces.
    restoreCurrentHandle(previousHandle);
    unpinHandle(previousHandle);
  }
}

export interface ResolvedRung {
  /** The path as the caller wrote it, used in report rows. */
  label: string;
  localPath: string;
  sizeMB: number;
}

/**
 * Resolve every path and check its size BEFORE anything is loaded.
 *
 * Ordering matters here: an unreadable or oversized rung five should fail in a
 * second, not after four multi-minute loads have already been paid for.
 */
export function resolveRungs(
  paths: string[],
  maxFileSizeMB?: number,
): {rungs: ResolvedRung[]; largestMB: number} {
  const rungs: ResolvedRung[] = [];
  let largestMB = 0;
  for (const p of paths) {
    const {localPath, fetchedFrom} = resolveSnapshotPath(p);
    if (!fs.existsSync(localPath)) {
      throw new Error(`File not found: ${localPath}`);
    }
    const sizeMB = fs.statSync(localPath).size / (1024 * 1024);
    largestMB = Math.max(largestMB, sizeMB);
    const limit = resolveMaxFileSizeMB(maxFileSizeMB, fetchedFrom != null);
    if (sizeMB > limit) {
      throw new Error(
        `${p} is ${sizeMB.toFixed(0)} MB — exceeds the ${limit} MB per-file ` +
          'limit. Raise it with max_file_size_mb.',
      );
    }
    rungs.push({label: p.replace(/^.*\//, ''), localPath, sizeMB});
  }
  return {rungs, largestMB};
}

/**
 * A full-heap walk on a multi-million-node graph does not finish inside the
 * 60 s eval default, and every caller discovering that by timing out first is
 * pure friction. Scale from the largest rung.
 */
export function scaledTimeoutMs(largestMB: number, explicit?: number): number {
  return explicit ?? Math.max(60000, Math.ceil(largestMB * 600));
}

/**
 * Re-arm the whole-heap scan guardrail for the work about to be done.
 *
 * Scaling a tool's own `timeout_ms` is NOT enough on its own, which is only
 * obvious once you run against a big graph. The guardrail in `guardrail.ts`
 * arms a 90s scan budget from the tool's incoming params before the handler
 * runs; a tool that then computes a larger per-snapshot timeout is still inside
 * that 90s budget, so a full-heap walk dies at 90s no matter what it asked for.
 * Measured on a real 690 MB / 5.1M-node Ads Manager capture: a detached-node
 * probe raised its eval timeout to 414s and still lost the rung to
 * `Scan exceeded its 90000ms budget`.
 *
 * Re-arming per snapshot is what `memlab_analyze_run` already does for its
 * steps. The guardrail's own `finally` disarms afterwards, so nothing leaks.
 */
export function armScanBudgetFor(timeoutMs: number): void {
  beginAnalysisBudget(timeoutMs);
}
