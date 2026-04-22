/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {ConsoleMode, SnapshotResultReader, findLeaks} from '@memlab/api';
import {config as memlabConfig} from '@memlab/core';
import type {ILeakFilter, ISerializedInfo} from '@memlab/core';
import type {LeakFilterFn, PhaseLabel} from './types';

// Inspector retention owned by CDP ($0-$4, selector handles). These
// labels are chrome-devtools-internal, so application node names cannot
// collide — safe to walk the full serialized trace.
const INSPECTOR_PATTERNS = [
  /DevTools console/i,
  /\(Inspector[^)]*\)/i,
  /CommandLineAPI/i,
];

const SUMMARY_MAX_LEN = 140;
const SUMMARY_TOP_N = 5;

/** @internal */
export function isInspectorArtifact(leak: ISerializedInfo): boolean {
  const matches = (s: string): boolean =>
    INSPECTOR_PATTERNS.some(rx => rx.test(s));
  const walk = (value: unknown): boolean => {
    if (typeof value === 'string') return matches(value);
    if (value == null || typeof value !== 'object') return false;
    for (const [key, child] of Object.entries(value)) {
      if (matches(key)) return true;
      if (walk(child)) return true;
    }
    return false;
  };
  return walk(leak);
}

/** @internal */
export function leakSummary(leak: ISerializedInfo): string {
  const trace = Object.keys(leak).find(k => !k.startsWith('$tabsOrder'));
  if (!trace) return 'leak';
  const clean = trace.replace(/\s+/g, ' ').trim();
  return clean.length > SUMMARY_MAX_LEN
    ? clean.slice(0, SUMMARY_MAX_LEN - 3) + '...'
    : clean;
}

/** @internal */
export function formatLeakMessage(leaks: ISerializedInfo[]): string {
  const head = leaks
    .slice(0, SUMMARY_TOP_N)
    .map((l, i) => `  #${i + 1}: ${leakSummary(l)}`)
    .join('\n');
  const tail =
    leaks.length > SUMMARY_TOP_N
      ? `\n  ... and ${leaks.length - SUMMARY_TOP_N} more`
      : '';
  return `memlab detected ${leaks.length} leak trace(s):\n${head}${tail}`;
}

/**
 * Run memlab's leak detector against the three snapshot files, installing
 * `leakFilter` on the global memlab config and restoring it afterwards.
 * @internal
 */
export async function runFindLeaks(
  paths: Record<PhaseLabel, string>,
  leakFilter: LeakFilterFn | undefined,
): Promise<ISerializedInfo[]> {
  const reader = SnapshotResultReader.fromSnapshots(
    paths.baseline,
    paths.target,
    paths.final,
  );
  if (!leakFilter) {
    return findLeaks(reader, {consoleMode: ConsoleMode.SILENT});
  }
  const external: ILeakFilter = {leakFilter};
  const prev = memlabConfig.externalLeakFilter;
  memlabConfig.externalLeakFilter = external;
  try {
    return await findLeaks(reader, {consoleMode: ConsoleMode.SILENT});
  } finally {
    memlabConfig.externalLeakFilter = prev;
  }
}
