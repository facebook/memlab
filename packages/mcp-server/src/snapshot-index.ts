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
 * A per-snapshot sidecar index, so the same rung is not re-parsed for the same
 * question.
 *
 * The parse is what costs. A ladder's rungs get re-parsed by `leak_report`,
 * `census_diff`, `artifact_budget`, `react_update_queues` and then again by
 * every follow-up `ladder_probe` — measured on one sweep, the same five
 * snapshots of one round were re-walked at least six times, at 22-43 s per
 * load. Yet several of those passes want nothing but a per-class or per-shape
 * COUNT, which is a few hundred kilobytes of derived data.
 *
 * So: build it once, write it next to the snapshot, and let a later question
 * be answered without opening the graph at all.
 *
 * **What is NOT here, and why.** The tempting entry is an edge-name -> node-id
 * index, which would turn the most common full-graph walk into a lookup. It is
 * left out because it is O(nodes): on a 4M-node capture that sidecar is
 * hundreds of megabytes, which trades a re-parse for a re-read of comparable
 * size and fills the same disk the snapshots already strain. The per-name
 * HOLDER COUNT is here instead — bounded by the distinct-name count, a few
 * thousand — because it answers the triage question ("is this name present at
 * all, and how many hold it?") that the walk was usually asked.
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import fs from 'fs';
import path from 'path';

/**
 * Bumped whenever the shape of the payload changes. A stale sidecar is then
 * rebuilt rather than misread — silently reading an old layout is the failure
 * mode a cache has that a recomputation does not.
 */
const INDEX_VERSION = 1;

/** Every numeric array index collapses to this one key. */
const INDEX_EDGE_NAME = '[i]';

/** Past this an edge "name" is a value, not a name. */
const MAX_INDEXED_EDGE_NAME = 120;

export interface SnapshotIndex {
  version: number;
  /** Identity of the file this was built from; all three must match. */
  sourceSize: number;
  sourceMtimeMs: number;
  nodeCount: number;
  edgeCount: number;
  /**
   * Self size over EVERY node, oddball roots included — so it matches what
   * `buildHistogram` reports and a cached rung and a freshly walked one give
   * the same heap total.
   */
  totalSelfSize: number;
  builtAtMs: number;
  /**
   * `<type>::<normalized class name>` -> [count, selfSize]. EXACT.
   *
   * Nothing is filtered out. An earlier version dropped single-instance
   * STRING classes, which is a large share of the table — a string node's
   * class name IS its content, so every distinct string value is its own
   * class — but it made a rung answered from the sidecar and a rung parsed
   * fresh report different rows, and cross-rung comparison is precisely what
   * the trend does. A cache that disagrees with the thing it caches is worse
   * than no cache.
   *
   * Size is bounded by refusing to WRITE an oversized sidecar instead (see
   * `sidecarAllowance`), which costs a re-parse and never a wrong number.
   */
  classes: Record<string, [number, number]>;
  /**
   * Sorted property set -> [count, selfSize, propCount], object nodes only.
   *
   * `propCount` is stored rather than derived from `key.split(',').length`
   * because a PROPERTY NAME can itself contain a comma, which makes the
   * derived count too high and drops the shape below a `max_props` filter
   * that a fresh census would have kept.
   */
  shapes: Record<string, [number, number, number]>;
  /**
   * Edge name -> holder count, by edge type. Numeric array indices collapse
   * to `[i]`, and names over 120 characters are dropped: both are values
   * rather than names, and either alone makes the sidecar scale with the heap.
   */
  edgeNames: Record<string, Record<string, number>>;
  detachedCount: number;
  /**
   * Nodes whose reference list could not be walked while building this.
   *
   * Stored so a cached rung can say its shape and edge-name tables are
   * short — otherwise a systematic read failure is indistinguishable from
   * an app that simply has fewer shapes.
   */
  unreadableNodes?: number;
}

/**
 * Join a sorted property list into a shape key, escaping the delimiter.
 *
 * A JS property name may itself contain a comma, so a plain `join(',')`
 * makes `{"a,b"}` and `{"a","b"}` the SAME key — two different record
 * types merged into one row, with a stored property count that then
 * disagrees with the key it sits beside. Escaping the backslash first
 * keeps the mapping reversible.
 *
 * Exported so the fresh census and the cached one build byte-identical
 * keys; a cache that disagrees with the thing it caches is worse than no
 * cache, and this is the input both sides derive their table from.
 */
export function joinShapeKey(props: readonly string[]): string {
  return props
    .map(p => p.replace(/\\/g, '\\\\').replace(/,/g, '\\,'))
    .join(',');
}

export function sidecarPathFor(snapshotPath: string): string {
  return `${snapshotPath}.memlab-index.json`;
}

/** Disabled with MEMLAB_NO_INDEX_CACHE=1, for a bisect or a cold measurement. */
export function indexCacheEnabled(): boolean {
  return process.env.MEMLAB_NO_INDEX_CACHE !== '1';
}

/**
 * Read a sidecar, or null when there is none, it is stale, or it is unreadable.
 *
 * Validated on file size AND mtime AND the counts recorded inside it. Content
 * hashing would be stronger and is not worth it: hashing a 500 MB file costs
 * about as much as re-parsing the part we cached.
 */
function isTuple(v: unknown, arity: number): boolean {
  return (
    Array.isArray(v) &&
    v.length === arity &&
    v.every(n => typeof n === 'number' && Number.isFinite(n))
  );
}

export function readSidecar(snapshotPath: string): SnapshotIndex | null {
  if (!indexCacheEnabled()) return null;
  const file = sidecarPathFor(snapshotPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(snapshotPath);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as SnapshotIndex;
    if (parsed.version !== INDEX_VERSION) return null;
    if (parsed.sourceSize !== stat.size) return null;
    if (parsed.sourceMtimeMs !== Math.round(stat.mtimeMs)) return null;
    // The metadata matching does not make the body well-formed. Any JSON
    // object passes the casts above, and a sidecar whose `classes` is missing
    // or null then reaches the callers as an EMPTY table rather than as an
    // error — which reads as "this rung has no growing classes", the exact
    // silent-zero this cache must not be able to produce. Cheap to check:
    // three typeof tests against a file that is otherwise trusted whole.
    const isTable = (v: unknown) => typeof v === 'object' && v !== null;
    if (
      !isTable(parsed.classes) ||
      !isTable(parsed.shapes) ||
      !isTable(parsed.edgeNames)
    ) {
      return null;
    }
    // The scalars too. `totalSelfSize` is the heap total every delta in a
    // trend is measured against, and a missing one reads back as `undefined`
    // — which arithmetic turns into NaN, and a NaN renders as a dash rather
    // than as an error. Same silent-zero class as an empty table, arriving
    // through a different field.
    if (
      !Number.isFinite(parsed.totalSelfSize) ||
      !Number.isFinite(parsed.nodeCount) ||
      !Number.isFinite(parsed.edgeCount) ||
      !Number.isFinite(parsed.detachedCount)
    ) {
      return null;
    }
    // EVERY entry, not a spot-check. `classes` is `[count, selfSize]` and
    // `shapes` is `[count, selfSize, propCount]`; a table of the right type
    // holding a wrong tuple turns a count into `undefined`, which
    // arithmetic renders as a dash rather than as a failure — and a reader
    // that falls back when `propCount` is missing then applies a DIFFERENT
    // rule to that one shape than a fresh census would. Checking the first
    // entry only is what makes a single bad row survive. This walks a table
    // already fully materialised by `JSON.parse`, so it costs a loop over a
    // few thousand small arrays against a read whose alternative is a 40 s
    // graph parse.
    for (const v of Object.values(parsed.classes)) {
      if (!isTuple(v, 2)) return null;
    }
    for (const v of Object.values(parsed.shapes)) {
      if (!isTuple(v, 3)) return null;
    }
    return parsed;
  } catch {
    // Absent, truncated or corrupt: rebuild. A cache is never a reason to
    // fail the question it was meant to speed up.
    return null;
  }
}

/**
 * How big a sidecar is allowed to be, against the snapshot it indexes.
 *
 * Neither a pure fraction nor a pure absolute cap works. A fraction alone
 * refuses to cache SMALL snapshots, where the derived data is a large share
 * of a small file and the cache is cheap in absolute terms; an absolute cap
 * alone refuses the LARGE snapshots, which are exactly the ones whose 40 s
 * parse the cache exists to avoid. So: a floor that always lets a small
 * snapshot be cached, and a proportional allowance above it, with a hard
 * ceiling so one pathological heap cannot write a gigabyte.
 *
 * Refusing is safe — the rung stays correct and stays slow. It is preferred
 * over trimming the table further, because a trimmed table makes a cached
 * rung disagree with a freshly walked one, which is the one thing a cache
 * must never do.
 */
const SIDECAR_FLOOR_BYTES = 2 * 1024 * 1024;
const SIDECAR_FRACTION = 0.1;
const SIDECAR_CEILING_BYTES = 64 * 1024 * 1024;

function sidecarAllowance(sourceSize: number): number {
  if (sourceSize <= 0) return SIDECAR_FLOOR_BYTES;
  return Math.min(
    SIDECAR_CEILING_BYTES,
    Math.max(SIDECAR_FLOOR_BYTES, sourceSize * SIDECAR_FRACTION),
  );
}

function writeSidecar(snapshotPath: string, index: SnapshotIndex): void {
  const file = sidecarPathFor(snapshotPath);
  try {
    // Written via a temp file in the same directory, so a concurrent reader
    // sees either the old sidecar or the new one, never half of one.
    const payload = JSON.stringify(index);
    // BYTE length. `payload.length` counts UTF-16 code units, so a sidecar
    // full of non-ASCII class names is larger on disk than the gate thinks
    // and slips past a ceiling expressed in bytes.
    if (
      Buffer.byteLength(payload, 'utf8') > sidecarAllowance(index.sourceSize)
    ) {
      return;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, file);
  } catch {
    // A read-only or full output directory must not fail the analysis. The
    // cache is an optimisation; losing it costs time, not correctness.
  }
}

/** The one pass that fills every section of the sidecar. */
export function buildSnapshotIndex(
  snapshot: IHeapSnapshot,
  snapshotPath: string,
  normalizeClassName: (name: string) => string,
): SnapshotIndex {
  const classes: Record<string, [number, number]> = {};
  const shapes: Record<string, [number, number, number]> = {};
  const edgeNames: Record<string, Record<string, number>> = {};
  let detachedCount = 0;
  let unreadableNodes = 0;
  let nodeCount = 0;
  let totalSelfSize = 0;

  snapshot.nodes.forEach((node: IHeapNode) => {
    nodeCount++;
    totalSelfSize += node.self_size;
    if (node.id <= 3) return;
    const key = `${node.type}::${normalizeClassName(node.name)}`;
    const c = classes[key];
    if (c) {
      c[0]++;
      c[1] += node.self_size;
    } else {
      classes[key] = [1, node.self_size];
    }
    if (node.is_detached || node.name.startsWith('Detached ')) detachedCount++;

    const props: string[] = [];
    const seenHere = new Set<string>();
    try {
      for (const e of node.references) {
        const raw = String(e.name_or_index);
        if (node.type === 'object' && e.type === 'property') {
          if (raw !== '__proto__') props.push(raw);
        }
        // An ARRAY INDEX is not a name. Left as-is, every element of every
        // array is its own key and the sidecar becomes a size-of-heap
        // artifact: measured on a 4.8 MB snapshot, 1.38 MB of sidecar, 28% of
        // the file it indexes. Collapsed, the table is bounded by the
        // distinct-name count, which is what makes this cache cheap.
        const name = /^\d+$/.test(raw) ? INDEX_EDGE_NAME : raw;
        // A long name is a VALUE — a URL, a serialized key — not a name worth
        // indexing, and a few of them dominate the file.
        if (name.length > MAX_INDEXED_EDGE_NAME) continue;
        // Per HOLDER, not per edge: an accessor pair emits two edges of the
        // same name and would otherwise double-count the holder.
        const seenKey = `${name}\u0000${e.type}`;
        if (seenHere.has(seenKey)) continue;
        seenHere.add(seenKey);
        let byType = edgeNames[name];
        if (byType == null) {
          byType = {};
          edgeNames[name] = byType;
        }
        byType[e.type] = (byType[e.type] ?? 0) + 1;
      }
    } catch {
      // A malformed edge costs this node's remaining edges, not the index —
      // but it is COUNTED. Swallowed silently, a systematic read failure
      // produced a sidecar with quietly-short shape and edge-name tables
      // that every later rung was then compared against, and nothing in
      // the output said the walk had been partial.
      unreadableNodes++;
    }
    if (node.type !== 'object' || props.length === 0) return;
    props.sort();
    const shapeKey = joinShapeKey(props);
    const s = shapes[shapeKey];
    if (s) {
      s[0]++;
      s[1] += node.self_size;
    } else {
      shapes[shapeKey] = [1, node.self_size, props.length];
    }
  });

  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(snapshotPath);
  } catch {
    stat = null;
  }
  return {
    version: INDEX_VERSION,
    sourceSize: stat?.size ?? -1,
    sourceMtimeMs: stat != null ? Math.round(stat.mtimeMs) : -1,
    nodeCount,
    edgeCount: snapshot.edges?.length ?? 0,
    totalSelfSize,
    builtAtMs: Date.now(),
    classes,
    shapes,
    edgeNames,
    detachedCount,
    unreadableNodes,
  };
}

/**
 * Build the sidecar for a snapshot that is already open, and persist it.
 *
 * Called from the load path, where the graph is in hand anyway, so the cost is
 * one extra pass rather than an extra parse.
 */
export function ensureSidecar(
  snapshot: IHeapSnapshot,
  snapshotPath: string,
  normalizeClassName: (name: string) => string,
): SnapshotIndex {
  const existing = readSidecar(snapshotPath);
  if (existing != null) return existing;
  const built = buildSnapshotIndex(snapshot, snapshotPath, normalizeClassName);
  if (indexCacheEnabled()) writeSidecar(snapshotPath, built);
  return built;
}

/** `classes` as the Map shape the ladder tools already pass around. */
export function classMapOf(
  index: SnapshotIndex,
): Map<string, {count: number; selfSize: number}> {
  const out = new Map<string, {count: number; selfSize: number}>();
  for (const [k, [count, selfSize]] of Object.entries(index.classes)) {
    out.set(k, {count, selfSize});
  }
  return out;
}

/** Every sidecar sitting beside the snapshots of a run directory. */
export function sidecarsIn(dir: string): string[] {
  const out: string[] = [];
  for (const sub of [path.join(dir, 'snapshots'), dir]) {
    let entries: string[];
    try {
      entries = fs.readdirSync(sub);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.endsWith('.memlab-index.json')) out.push(path.join(sub, e));
    }
  }
  return out;
}
