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
import {tickAnalysis} from './analysis-budget.js';

export type SnapshotEnv = 'browser' | 'node' | 'unknown';

// Wrap the snapshot's full-collection iterators so every heap walk feeds the
// active wall-clock guardrail (see analysis-budget.ts) without each tool having
// to wire it in. `snapshot.nodes`/`snapshot.edges` are stable objects assigned
// once at parse time, so patching their `forEach` once is durable; we mark the
// collection to stay idempotent across the many getSnapshot() calls per session.
const TICK_PATCHED = '__memlabTickPatched';

function patchForEachMethods(collection: unknown, methods: string[]): void {
  if (!collection || typeof collection !== 'object') return;
  const c = collection as Record<string, unknown>;
  if (c[TICK_PATCHED]) return;
  for (const m of methods) {
    const fn = c[m];
    if (typeof fn !== 'function') continue;
    const orig = (fn as (cb: (...a: unknown[]) => unknown) => unknown).bind(c);
    c[m] = (cb: (...a: unknown[]) => unknown) =>
      orig((...args: unknown[]) => {
        tickAnalysis();
        return cb(...args);
      });
  }
  Object.defineProperty(c, TICK_PATCHED, {value: true, enumerable: false});
}

function instrumentSnapshot(snapshot: IHeapSnapshot): void {
  const s = snapshot as unknown as {nodes?: unknown; edges?: unknown};
  patchForEachMethods(s.nodes, ['forEach', 'forEachTraceable']);
  patchForEachMethods(s.edges, ['forEach']);
}

export interface SnapshotMetadata {
  /**
   * Stable, human-friendly handle for this snapshot within the session.
   * Node ids are only valid relative to the snapshot they were read from;
   * the handle identifies which loaded snapshot a given id belongs to.
   */
  handle: string;
  filePath: string;
  fileName: string;
  nodeCount: number;
  edgeCount: number;
  totalSize: number;
  env: SnapshotEnv;
  /**
   * True when the snapshot was parsed WITHOUT memlab's path/dominator pass
   * (`memlab_load_snapshot({light: true})`). Roughly halves load time, at the
   * cost of `retainedSize`, `dominatorNode` and `pathEdge` being absent — see
   * {@link getSnapshot}.
   */
  light: boolean;
}

interface LoadedSnapshot {
  snapshot: IHeapSnapshot;
  metadata: SnapshotMetadata;
}

// Multiple snapshots can be resident at once (for diffing and before/after
// comparison). The "current" handle is the default target for tools that
// don't take an explicit snapshot argument.
const loaded = new Map<string, LoadedSnapshot>();
let currentHandle: string | null = null;

// Monotonic access stamp per handle, for LRU eviction under memory pressure.
// A counter rather than a clock: two snapshots can be touched inside the same
// millisecond, and only the ORDER matters here.
const lastUsed = new Map<string, number>();
let useCounter = 0;

function touch(handle: string | null): void {
  if (handle != null) lastUsed.set(handle, ++useCounter);
}

/**
 * Drop the least-recently-used resident snapshot, never the current one.
 * Returns its metadata, or null when there is nothing else to evict.
 *
 * Used by the loader's memory-headroom guard: with `keep_previous`, several
 * full graphs stay resident, and the load that tips the process over is the one
 * that dies — taking every resident snapshot with it. Evicting the coldest one
 * first turns an OOM crash into a slower session.
 */
export function evictLeastRecentlyUsed(): SnapshotMetadata | null {
  let victim: string | null = null;
  let victimStamp = Infinity;
  for (const handle of loaded.keys()) {
    if (handle === currentHandle) continue;
    const stamp = lastUsed.get(handle) ?? 0;
    if (stamp < victimStamp) {
      victimStamp = stamp;
      victim = handle;
    }
  }
  if (victim == null) return null;
  const meta = loaded.get(victim)?.metadata ?? null;
  loaded.delete(victim);
  lastUsed.delete(victim);
  dropEvalScratch(victim);
  return meta;
}

// Per-snapshot scratch space for memlab_eval sessions: lets a custom script
// build an index once (e.g. class/typename → ids) and reuse it across
// subsequent eval calls instead of re-scanning millions of nodes every time.
// Keyed by handle so switching snapshots never crosses the streams; dropped
// when the snapshot is replaced/unloaded so a stale index can't outlive its
// snapshot.
const evalScratch = new Map<string, Record<string, unknown>>();

/**
 * Returns the mutable scratch object for the current snapshot, creating it on
 * first use. Node ids and any derived index are only valid for the snapshot they
 * were built from, so the scratch is keyed to the active handle.
 */
export function getEvalScratch(): Record<string, unknown> {
  const key = currentHandle ?? '__none__';
  let s = evalScratch.get(key);
  if (!s) {
    s = {};
    evalScratch.set(key, s);
  }
  return s;
}

function dropEvalScratch(handle: string | null): void {
  if (handle == null) {
    evalScratch.clear();
    return;
  }
  evalScratch.delete(handle);
}

/**
 * Session-level output controls to trim repeated boilerplate tokens.
 * - `quietHeader`: when true, the per-call snapshot header is printed only
 *   once per loaded snapshot instead of on every tool result.
 * - `suppressSuggestions`: when true, tools omit their "Suggested next steps"
 *   trailers.
 */
export interface SessionConfig {
  quietHeader: boolean;
  suppressSuggestions: boolean;
}

const sessionConfig: SessionConfig = {
  quietHeader: false,
  suppressSuggestions: false,
};

// Tracks whether the header has been emitted since the current snapshot was
// loaded/activated, so `quietHeader` can print it exactly once.
let headerEmitted = false;

export function getSessionConfig(): SessionConfig {
  return sessionConfig;
}

export function setSessionConfig(patch: Partial<SessionConfig>): SessionConfig {
  if (patch.quietHeader != null) sessionConfig.quietHeader = patch.quietHeader;
  if (patch.suppressSuggestions != null) {
    sessionConfig.suppressSuggestions = patch.suppressSuggestions;
  }
  return sessionConfig;
}

/**
 * Returns true exactly once per loaded snapshot when `quietHeader` is on,
 * and always when it is off. Tools call this from `toolResult` to decide
 * whether to prepend the snapshot header.
 */
export function shouldEmitHeader(): boolean {
  if (!sessionConfig.quietHeader) return true;
  if (headerEmitted) return false;
  headerEmitted = true;
  return true;
}

/**
 * Standing explanatory notes — artifact-family write-ups, capture-mode caveats,
 * "a candidate is not a verdict" — are the same text on every call, and a trend
 * tool gets called many times per investigation (8 times in one measured
 * session). The information is worth stating; restating it is not. Returns true
 * the FIRST time a key is seen in this server process and false thereafter, so
 * a caller can print the long form once and a one-line pointer after that.
 *
 * Session-scoped on purpose, not per-snapshot: the reader is the same agent
 * across snapshots, and re-teaching it the same caveat when it switches rungs is
 * exactly the repetition being removed.
 */
const emittedNotes = new Set<string>();

export function shouldEmitNote(key: string): boolean {
  if (emittedNotes.has(key)) return false;
  emittedNotes.add(key);
  return true;
}

/** True if `key` has already been emitted, without marking it. */
export function noteAlreadyEmitted(key: string): boolean {
  return emittedNotes.has(key);
}

/** Force the standing notes to print again (used by `repeat_notes`). */
export function resetEmittedNotes(): void {
  emittedNotes.clear();
}

function uniqueHandle(base: string): string {
  // Sanitize to a short slug, then disambiguate against existing handles.
  const slug =
    base
      .replace(/\.heapsnapshot$/i, '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'snapshot';
  if (!loaded.has(slug)) return slug;
  let i = 2;
  while (loaded.has(`${slug}#${i}`)) i++;
  return `${slug}#${i}`;
}

/**
 * The current snapshot.
 *
 * A LIGHT snapshot (loaded with `light: true`) has no dominator tree, no
 * retained sizes and no shortest-path edges. On such a snapshot `retainedSize`
 * reads 0 and `dominatorNode` / `pathEdge` are absent — which does not throw, it
 * silently produces zeros and empty traces. A tool that reported those as
 * results would be confidently wrong, which is worse than refusing.
 *
 * So light access is DENY-BY-DEFAULT and must be opted into per call site with
 * `{allowLight: true}`, by tools that read only counts, names, types, self
 * sizes, string values or edges. Enforcing it here rather than in the tool
 * wrapper is deliberate: this is the one funnel every tool goes through,
 * including tools dispatched in-process by `memlab_batch`, which bypass the
 * guardrail wrapper entirely.
 */
export function getSnapshot(opts?: {allowLight?: boolean}): IHeapSnapshot {
  const entry = currentHandle ? loaded.get(currentHandle) : undefined;
  if (!entry) {
    throw new Error('No heap snapshot loaded. Use memlab_load_snapshot first.');
  }
  if (entry.metadata.light && !opts?.allowLight) {
    throw new Error(
      `Snapshot "${entry.metadata.handle}" was loaded in LIGHT mode, which skips the dominator/retained-size pass — this analysis needs it. ` +
        'Light mode supports count / name / type / self-size / string queries only: memlab_class_histogram (with include_retained_size:false), memlab_search_nodes (without min_retained_size), memlab_search_strings, memlab_string_patterns, plus memlab_snapshot_header and memlab_snapshots, which do not read the graph. ' +
        `Reload for full analysis: memlab_load_snapshot({file_path: "${entry.metadata.filePath}"}).`,
    );
  }
  touch(currentHandle);
  instrumentSnapshot(entry.snapshot);
  return entry.snapshot;
}

/** True when the current snapshot was loaded without the dominator pass. */
export function isLightSnapshot(): boolean {
  if (!currentHandle) return false;
  return loaded.get(currentHandle)?.metadata.light === true;
}

export function getFilePath(): string | null {
  if (!currentHandle) return null;
  return loaded.get(currentHandle)?.metadata.filePath ?? null;
}

export function getSnapshotEnv(): SnapshotEnv {
  if (!currentHandle) return 'unknown';
  return loaded.get(currentHandle)?.metadata.env ?? 'unknown';
}

export function getSnapshotMetadata(): SnapshotMetadata | null {
  if (!currentHandle) return null;
  return loaded.get(currentHandle)?.metadata ?? null;
}

/**
 * Register a snapshot and make it the current one.
 *
 * @param snapshot parsed heap snapshot
 * @param filePath absolute path the snapshot was loaded from
 * @param metadata derived stats (handle is assigned here if not supplied)
 * @param opts.alias preferred handle; falls back to the file name
 * @param opts.replace when true (default), unload all other snapshots first,
 *        preserving the single-resident memory profile. When false, keep
 *        previously-loaded snapshots resident for diffing/comparison.
 */
export function setSnapshot(
  snapshot: IHeapSnapshot,
  filePath: string,
  metadata: Omit<SnapshotMetadata, 'filePath' | 'handle' | 'light'> & {
    light?: boolean;
  },
  opts: {alias?: string; replace?: boolean} = {},
): SnapshotMetadata {
  const replace = opts.replace ?? true;
  if (replace) {
    loaded.clear();
    dropEvalScratch(null);
  }
  const handle = uniqueHandle(opts.alias || metadata.fileName);
  const full: SnapshotMetadata = {
    handle,
    filePath,
    ...metadata,
    light: metadata.light === true,
  };
  loaded.set(handle, {snapshot, metadata: full});
  currentHandle = handle;
  touch(handle);
  headerEmitted = false;
  return full;
}

export function listSnapshots(): SnapshotMetadata[] {
  return [...loaded.values()].map(l => l.metadata);
}

/**
 * Drop all resident snapshots and reset the current handle. Used to release the
 * previous snapshot's memory BEFORE parsing a replacement, so peak RSS during a
 * large load is one heap rather than two (avoids the GC death-spiral described
 * in P2403258184 §3).
 */
export function clearAllSnapshots(): void {
  loaded.clear();
  lastUsed.clear();
  dropEvalScratch(null);
  currentHandle = null;
  headerEmitted = false;
}

/**
 * A resident snapshot loaded from this exact path, if any.
 *
 * The point of a snapshot cache is to not re-parse a file this process already
 * has in memory; that check has to key on the resolved path, since the handle is
 * derived from the file name and may have been disambiguated.
 */
export function findResidentByPath(filePath: string): SnapshotMetadata | null {
  for (const {metadata} of loaded.values()) {
    if (metadata.filePath === filePath) return metadata;
  }
  return null;
}

/**
 * Drop every resident snapshot except `handle`, which becomes current.
 *
 * Used by the load cache-hit path so a hit is indistinguishable from a real load
 * apart from speed: a replace-mode load unloads the others, and a hit must do
 * the same or the two paths leave different state behind.
 */
export function retainOnlySnapshot(handle: string): boolean {
  if (!loaded.has(handle)) return false;
  for (const h of [...loaded.keys()]) {
    if (h === handle) continue;
    loaded.delete(h);
    lastUsed.delete(h);
    dropEvalScratch(h);
  }
  currentHandle = handle;
  touch(handle);
  headerEmitted = false;
  return true;
}

export function getCurrentHandle(): string | null {
  return currentHandle;
}

export function getSnapshotByHandle(handle: string): IHeapSnapshot | null {
  return loaded.get(handle)?.snapshot ?? null;
}

export function getMetadataByHandle(handle: string): SnapshotMetadata | null {
  return loaded.get(handle)?.metadata ?? null;
}

export function setCurrentSnapshot(handle: string): boolean {
  if (!loaded.has(handle)) return false;
  currentHandle = handle;
  touch(handle);
  headerEmitted = false;
  return true;
}

export function removeSnapshot(handle: string): boolean {
  const existed = loaded.delete(handle);
  if (existed) {
    lastUsed.delete(handle);
    dropEvalScratch(handle);
  }
  if (existed && currentHandle === handle) {
    currentHandle = loaded.size > 0 ? [...loaded.keys()][0] : null;
    headerEmitted = false;
  }
  return existed;
}
