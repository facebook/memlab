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
 * What large snapshots cost this server, measured as it runs: load time and
 * memory per load, the process's peak memory, evictions, and per-tool
 * latency. Reported by `memlab_server_status`, so "is this capture too big for
 * this machine?" and "which call is slow?" are answered from numbers rather
 * than guesses.
 */

interface LoadRecord {
  file: string;
  kind: string;
  nodes: number;
  seconds: number;
  rssBefore: number;
  rssAfter: number;
}

interface CallStats {
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
}

const MAX_LOADS = 20;
const loads: LoadRecord[] = [];
const evictions: Array<{handle: string; at: number}> = [];
const calls = new Map<string, CallStats>();

export function recordLoad(entry: LoadRecord): void {
  loads.push(entry);
  if (loads.length > MAX_LOADS) loads.shift();
}

export function recordEviction(handle: string): void {
  evictions.push({handle, at: Date.now()});
  if (evictions.length > MAX_LOADS) evictions.shift();
}

export function recordCall(tool: string, ms: number): void {
  let s = calls.get(tool);
  if (s == null) {
    s = {count: 0, totalMs: 0, maxMs: 0, lastMs: 0};
    calls.set(tool, s);
  }
  s.count++;
  s.totalMs += ms;
  s.maxMs = Math.max(s.maxMs, ms);
  s.lastMs = ms;
}

/** Time `fn` and record it as a load of `file`. */
export async function timedLoad<T extends {nodes?: {length: number}}>(
  file: string,
  kind: LoadRecord['kind'],
  fn: () => Promise<T>,
): Promise<T> {
  const rssBefore = process.memoryUsage().rss;
  const started = Date.now();
  let nodes = 0;
  let failed = true;
  try {
    const result = await fn();
    nodes = result.nodes?.length ?? 0;
    failed = false;
    return result;
  } finally {
    // A load that dies (out of memory, a corrupt file) is the one most worth
    // seeing here, so it is recorded too.
    recordLoad({
      file: file.replace(/^.*\//, ''),
      kind: failed ? `${kind} (failed)` : kind,
      nodes,
      seconds: (Date.now() - started) / 1000,
      rssBefore,
      rssAfter: process.memoryUsage().rss,
    });
  }
}

/** Peak resident memory of this process so far, in bytes. */
export function peakRss(): number {
  // `maxRSS` is in kilobytes on every platform: libuv's uv_getrusage divides
  // macOS's byte count by 1024 before Node sees it.
  return process.resourceUsage().maxRSS * 1024;
}

export interface PerfSnapshot {
  peakRss: number;
  loads: LoadRecord[];
  evictions: Array<{handle: string; at: number}>;
  slowestTools: Array<{tool: string} & CallStats>;
}

export function perfSnapshot(topTools = 5): PerfSnapshot {
  return {
    peakRss: peakRss(),
    loads: [...loads],
    evictions: [...evictions],
    slowestTools: [...calls.entries()]
      .map(([tool, s]) => ({tool, ...s}))
      .sort((a, b) => b.maxMs - a.maxMs || a.tool.localeCompare(b.tool))
      .slice(0, topTools),
  };
}
