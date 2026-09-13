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

// CDP inspector-owned retainer labels ($0-$4, selector handles).
const INSPECTOR_PATTERNS = [
  /DevTools console/i,
  /\(Inspector[^)]*\)/i,
  /CommandLineAPI/i,
];

const INTERNAL_KEY_PREFIXES = ['$tabsOrder'];
const LEAKED_KEY_MARKERS = ['$memLabTag:leaked', '$highlight'];
const SUMMARY_MAX_LEN = 140;
const SUMMARY_TOP_N = 5;

const isInternalKey = (key: string): boolean =>
  INTERNAL_KEY_PREFIXES.some(p => key.startsWith(p));

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
  const keys = Object.keys(leak).filter(k => !isInternalKey(k));
  const leaked = keys.find(k => LEAKED_KEY_MARKERS.some(m => k.includes(m)));
  const chosen = leaked ?? keys[keys.length - 1];
  if (!chosen) return 'leak';
  const clean = chosen.replace(/\s+/g, ' ').trim();
  return clean.length > SUMMARY_MAX_LEN
    ? clean.slice(0, SUMMARY_MAX_LEN - 3) + '...'
    : clean;
}

/** @internal JSON.stringify replacer that drops memlab-internal keys. */
export function stripInternalKeysReplacer(
  key: string,
  value: unknown,
): unknown {
  return isInternalKey(key) ? undefined : value;
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
 * Run memlab leak detection on a baseline/target/final snapshot triple.
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
