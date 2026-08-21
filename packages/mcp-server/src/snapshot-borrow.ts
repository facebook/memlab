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
import fs from 'fs';
import memlabHeapAnalysis from '@memlab/heap-analysis';
const {getFullHeapFromFile} = memlabHeapAnalysis;
import {
  findResidentByPath,
  getCurrentHandle,
  getSnapshotByHandle,
  removeSnapshot,
  setCurrentSnapshot,
  setSnapshot,
} from './heap-state.js';
import {beginAnalysisBudget} from './analysis-budget.js';
import {
  resolveMaxFileSizeMB,
  resolveSnapshotPath,
} from './tools/load-snapshot.js';

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

  try {
    if (snapshot == null) {
      snapshot = await getFullHeapFromFile(localPath);
      const meta = setSnapshot(
        snapshot,
        localPath,
        {
          fileName: localPath.replace(/^.*\//, ''),
          nodeCount: snapshot.nodes?.length ?? 0,
          edgeCount: snapshot.edges?.length ?? 0,
          totalSize: 0,
          env: 'unknown',
        },
        {replace: false},
      );
      temporaryHandle = meta.handle;
    } else if (resident != null) {
      setCurrentSnapshot(resident.handle);
    }
    return await fn(snapshot);
  } finally {
    if (temporaryHandle != null) removeSnapshot(temporaryHandle);
    if (previousHandle != null) setCurrentSnapshot(previousHandle);
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
