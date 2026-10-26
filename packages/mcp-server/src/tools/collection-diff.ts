/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapEdge, IHeapNode, IHeapSnapshot} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import memlabCore from '@memlab/core';
import {z} from 'zod';
import {
  enumerateMapEntries,
  enumerateSetElements,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  pathsHeader,
  toolResult,
} from '../utils.js';
import {countEntries} from './collection-trend.js';
import {cachedModuleScopes} from './module-attribution.js';
import {moduleOfScope} from '../module-registry.js';
import {resolveRunOrPaths} from './ladder.js';
import {segmentArg} from '../run-manifest.js';
import {resolveMaxFileSizeMB, resolveSnapshotPath} from './load-snapshot.js';

const {utils: memlabUtils} = memlabCore;

/**
 * Class names that carry no information as an owner label. A signature built on
 * one of these is not distinguishable from thousands of others, so the walk
 * keeps climbing to find something nameable.
 */
const GENERIC_OWNER_NAMES = new Set([
  '',
  'Object',
  'Array',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  '(object elements)',
  '(object properties)',
]);

/** JS-level collections a caller can actually act on. */
const COLLECTION_CLASS_NAMES = new Set([
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Array',
]);

const MAX_OWNER_HOPS = 4;

function isGenericOwner(name: string): boolean {
  if (GENERIC_OWNER_NAMES.has(name)) return true;
  // `system / Context / scope @805823` — the scope id is per-capture, so the
  // name is both generic AND unstable. Collapsed to `<context>` below.
  if (name.startsWith('system / Context')) return true;
  if (name.startsWith('system /')) return true;
  return false;
}

function edgeLabel(edge: IHeapEdge): string | null {
  const raw = String(edge.name_or_index);
  if (raw === '' || /^\d+$/.test(raw)) return null;
  if (raw === '__proto__' || raw === 'map' || raw === 'elements') return null;
  return raw;
}

/**
 * A per-capture-stable name for one collection, in the SAME `<Owner>.<property>`
 * form `memlab_collection_trend` takes as a locator.
 *
 * That shared shape is the point of this tool: discovery hands you a locator you
 * can paste straight into the trend tool to confirm and to track a fix, instead
 * of a node id that means nothing in the next capture.
 *
 * Node ids, array indices and V8 scope numbers are all per-capture, so none of
 * them can appear in the signature. The walk climbs referrers (not the dominator
 * tree — this runs on a LIGHT parse with no dominators) until it finds a class
 * name worth printing, and falls back to `<context>` for a module-scope closure
 * binding, which is where most module singletons live.
 *
 * Returns the signature plus the node it names as owner (a context for
 * `<context>`).
 */
export function collectionOwner(
  node: IHeapNode,
): {sig: string; owner: IHeapNode | null} | null {
  let binding: string | null = null;
  let owner: IHeapNode | null = null;
  // Prefer a `property` binding, then a closure `context` binding; both name the
  // field the collection is stored in, which is what a reader needs.
  for (const pass of ['property', 'context', 'any'] as const) {
    for (const edge of node.referrers) {
      if (pass !== 'any' && edge.type !== pass) continue;
      if (edge.type === 'hidden' || edge.type === 'internal') continue;
      const label = edgeLabel(edge);
      if (label == null) continue;
      const from = edge.fromNode;
      if (from == null || from.id <= 3) continue;
      binding = label;
      owner = from;
      break;
    }
    if (binding != null) break;
  }
  if (binding == null || owner == null) return null;

  // Climb until the owner has a name worth printing.
  let hops = 0;
  const prefixParts: string[] = [];
  let cur: IHeapNode | null = owner;
  while (cur != null && hops < MAX_OWNER_HOPS && isGenericOwner(cur.name)) {
    let next: IHeapNode | null = null;
    let nextLabel: string | null = null;
    for (const edge of (cur as IHeapNode).referrers) {
      if (edge.type === 'hidden' || edge.type === 'internal') continue;
      const label = edgeLabel(edge);
      if (label == null) continue;
      const from: IHeapNode | null = edge.fromNode ?? null;
      if (from == null || from.id <= 3) continue;
      next = from;
      nextLabel = label;
      break;
    }
    if (next == null) break;
    if (nextLabel != null) prefixParts.unshift(nextLabel);
    cur = next;
    hops++;
  }
  let ownerLabel: string;
  if (cur == null) {
    ownerLabel = 'Object';
  } else if (cur.name.startsWith('system / Context')) {
    ownerLabel = '<context>';
  } else if (isGenericOwner(cur.name)) {
    ownerLabel = cur.name.length > 0 ? cur.name : 'Object';
  } else {
    ownerLabel = cur.name;
  }
  return {sig: [ownerLabel, ...prefixParts, binding].join('.'), owner: cur};
}

/**
 * Bytes a collection holds, estimated: its own and backing-store self size,
 * plus its entry count times the mean payload of its first entries (each
 * entry's key and value, and their direct children). An estimate because this
 * runs on a LIGHT parse with no retained sizes, and because a dominator-exact
 * figure per collection per rung would cost a dominator pass per rung.
 */
// Bounded per collection: this runs for every collection on every rung, most
// of which the growth filter then drops.
const SAMPLE_ENTRIES = 8;
const PAYLOAD_DEPTH = 3;
const PAYLOAD_MAX_NODES = 64;

/**
 * Self bytes reachable from one entry within a few hops: a cache value is
 * usually a record whose payload (a base64 thumbnail, a parsed body) sits one
 * or two properties down. Code, closures, prototypes and hidden-class maps are
 * skipped — they are shared, not owned by the entry.
 */
function payloadOf(node: IHeapNode | null): number {
  if (node == null || node.id <= 3) return 0;
  const seen = new Set<number>([node.id]);
  let bytes = node.self_size;
  let frontier = [node];
  for (let depth = 0; depth < PAYLOAD_DEPTH && frontier.length > 0; depth++) {
    const next: IHeapNode[] = [];
    for (const cur of frontier) {
      for (const e of cur.references) {
        if (seen.size >= PAYLOAD_MAX_NODES) return bytes;
        if (e.type === 'weak' || e.type === 'shortcut') continue;
        const key = String(e.name_or_index);
        if (key === 'map' || key === '__proto__' || key === 'constructor') {
          continue;
        }
        const t = e.toNode;
        if (t.id <= 3 || seen.has(t.id)) continue;
        if (t.type === 'closure' || t.type === 'code' || t.type === 'hidden') {
          continue;
        }
        seen.add(t.id);
        bytes += t.self_size;
        next.push(t);
      }
    }
    frontier = next;
  }
  return bytes;
}

export function estimateCollectionBytes(
  node: IHeapNode,
  entries: number,
): number {
  let own = node.self_size;
  const sampled: Array<IHeapNode | null> = [];
  if (node.name === 'Map' || node.name === 'WeakMap') {
    for (const en of enumerateMapEntries(node).slice(0, SAMPLE_ENTRIES)) {
      sampled.push(en.key);
      sampled.push(en.value);
    }
  } else if (node.name === 'Set' || node.name === 'WeakSet') {
    for (const el of enumerateSetElements(node).slice(0, SAMPLE_ENTRIES)) {
      sampled.push(el);
    }
  } else {
    for (const e of node.references) {
      if (e.type === 'element' && sampled.length < SAMPLE_ENTRIES) {
        sampled.push(e.toNode);
      }
    }
  }
  for (const e of node.references) {
    const key = String(e.name_or_index);
    if (key === 'table' || key === 'elements') own += e.toNode.self_size;
  }
  if (sampled.length === 0) return own;
  const perSampledEntry =
    sampled.reduce((sum, n) => sum + payloadOf(n), 0) /
    (node.name === 'Map' || node.name === 'WeakMap'
      ? Math.max(1, sampled.length / 2)
      : sampled.length);
  return Math.round(own + perSampledEntry * entries);
}

export interface CollectionStat {
  instances: number;
  entries: number;
  maxEntries: number;
  kinds: Set<string>;
  bytes: number;
  // `<Module>.<binding>` when the owner is a module's top-level scope.
  moduleLabel: string | null;
  // The `collection_trend` locator (`<Owner>.<prop>` / `<context>.<var>`).
  locator: string;
}

/**
 * Census every JS collection in one snapshot, keyed by signature.
 *
 * Deliberately does NOT filter by size. The whole point is to catch the
 * collection that is small now and unbounded later: one of the three
 * never-drained telemetry stores this tool was written for held 2 entries at the
 * baseline rung and 1,260 at the last one, so any size floor would have hidden
 * it. Growth is the filter, and growth needs the ladder.
 */
export function censusCollections(
  snapshot: IHeapSnapshot,
): Map<string, CollectionStat> {
  const out = new Map<string, CollectionStat>();
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.id <= 3) return;
    if (!COLLECTION_CLASS_NAMES.has(node.name)) return;
    const n = countEntries(node);
    if (n == null || n === 0) return;
    const named = collectionOwner(node);
    if (named == null) return;
    const sig = named.sig;
    // A module-scope binding is keyed by its module too: `<context>.cache`
    // in two modules is two collections, and merging them would credit one
    // module with both modules' growth.
    let moduleLabel: string | null = null;
    // Only a module's TOP-LEVEL scope: a collection in a function or hook
    // closure nested inside the module is one per call, and summing those
    // instances under `<Module>.<var>` would flag owners accumulating as a
    // module cache.
    if (sig.startsWith('<context>.') && named.owner != null) {
      const module =
        cachedModuleScopes(snapshot).get(named.owner.id) ??
        moduleOfScope(snapshot, named.owner, true);
      if (module != null) moduleLabel = `${module}.${sig.slice(10)}`;
    }
    const key = moduleLabel ?? sig;
    let s = out.get(key);
    if (!s) {
      s = {
        instances: 0,
        entries: 0,
        maxEntries: 0,
        kinds: new Set(),
        bytes: 0,
        moduleLabel,
        locator: sig,
      };
      out.set(key, s);
    }
    s.instances++;
    s.entries += n;
    s.bytes += estimateCollectionBytes(node, n);
    if (n > s.maxEntries) s.maxEntries = n;
    s.kinds.add(node.name);
  });
  return out;
}

interface Row {
  sig: string;
  kind: string;
  series: number[];
  instances: number[];
  maxEntries: number;
  delta: number;
  bytesDelta: number;
  monotonic: boolean;
  moduleLabel: string | null;
  locator: string;
  // Module-scope, grew at every rung, never shrank: an unbounded module cache.
  moduleCache: boolean;
}

/**
 * Module resolution can succeed on one rung and miss on another, which would
 * split one collection into a `<Module>.<var>` row and a `<context>.<var>` row
 * with half a series each. When exactly one module claims `<context>.<var>`
 * and the loose key appears only on rungs where that module's key is missing,
 * the loose stat is that collection on those rungs and is re-keyed to it.
 */
export function reconcileModuleKeys(
  perRung: Map<string, CollectionStat>[],
): void {
  const claims = new Map<string, Set<string>>();
  for (const m of perRung) {
    for (const [key, stat] of m) {
      if (stat.moduleLabel == null) continue;
      const keys = claims.get(stat.locator) ?? new Set<string>();
      keys.add(key);
      claims.set(stat.locator, keys);
    }
  }
  for (const [locator, keys] of claims) {
    if (keys.size !== 1) continue;
    const [key] = keys;
    if (perRung.some(m => m.has(key) && m.has(locator))) continue;
    const label = perRung.find(m => m.has(key))?.get(key)?.moduleLabel ?? null;
    for (const m of perRung) {
      const loose = m.get(locator);
      if (m.has(key) || loose == null) continue;
      m.set(key, {...loose, moduleLabel: label});
      m.delete(locator);
    }
  }
}

// A module-scope collection that grows at every rung is reported from this
// small a growth: an unbounded cache adds one entry per distinct key, and a
// handful of keys per round is all a short ladder shows.
const MODULE_CACHE_MIN_GROWTH = 5;

// From the newest rung that has the collection: one missing on the last rung
// would otherwise price its growth at 0 and sink it in the bytes ranking.
function bytesPerEntryAtLast(
  perRung: Map<string, CollectionStat>[],
  sig: string,
): number {
  for (let i = perRung.length - 1; i >= 0; i--) {
    const stat = perRung[i].get(sig);
    if (stat != null && stat.entries > 0) return stat.bytes / stat.entries;
  }
  return 0;
}

function buildRows(
  perRung: Map<string, CollectionStat>[],
  minGrowth: number,
  rankBy: 'bytes' | 'entries',
): Row[] {
  const sigs = new Set<string>();
  for (const m of perRung) for (const k of m.keys()) sigs.add(k);
  const rows: Row[] = [];
  for (const sig of sigs) {
    const series = perRung.map(m => m.get(sig)?.entries ?? 0);
    const instances = perRung.map(m => m.get(sig)?.instances ?? 0);
    const delta = series[series.length - 1] - series[0];
    let monotonic = true;
    for (let i = 1; i < series.length; i++) {
      if (series[i] <= series[i - 1]) monotonic = false;
    }
    const moduleLabel =
      perRung.map(m => m.get(sig)?.moduleLabel).find(l => l != null) ?? null;
    const locator =
      perRung.map(m => m.get(sig)?.locator).find(l => l != null) ?? sig;
    const moduleCache = moduleLabel != null && monotonic;
    if (
      delta < minGrowth &&
      !(moduleCache && delta >= MODULE_CACHE_MIN_GROWTH)
    ) {
      continue;
    }
    const kinds = new Set<string>();
    for (const m of perRung) {
      const s = m.get(sig);
      if (s) for (const k of s.kinds) kinds.add(k);
    }
    rows.push({
      sig,
      kind: [...kinds].sort().join('/'),
      series,
      instances,
      maxEntries: Math.max(...perRung.map(m => m.get(sig)?.maxEntries ?? 0)),
      delta,
      // The entry delta priced at the last rung's bytes per entry. Each rung
      // re-samples its first entries, so differencing two rungs' estimates
      // can turn a growing collection's bytes negative.
      bytesDelta: Math.round(bytesPerEntryAtLast(perRung, sig) * delta),
      monotonic,
      moduleLabel,
      locator,
      moduleCache,
    });
  }
  rows.sort((a, b) => {
    if (a.monotonic !== b.monotonic) return a.monotonic ? -1 : 1;
    return rankBy === 'bytes' ? b.bytesDelta - a.bytesDelta : b.delta - a.delta;
  });
  return rows;
}

// `formatBytes` refuses negatives (it prints N/A), and an estimated delta can
// be negative on a row that grew in entries.
function signedBytes(v: number): string {
  return `${v < 0 ? '-' : '+'}${formatBytes(Math.abs(v))}`;
}

export function registerCollectionDiff(server: McpServer): void {
  server.tool(
    'memlab_collection_diff',
    'Find WHICH collections grew across a snapshot ladder, WITHOUT being told their names. Censuses every Map/Set/WeakMap/WeakSet/Array on every rung, keys each by a per-capture-STABLE `<Owner>.<property>` signature, and diffs the entry counts. ' +
      'This is the discovery half of memlab_collection_trend, which is excellent but requires a locator you must already know — so every accumulating collection had to be found first by hand-tracing a retainer path, and the ones nobody thought to trace were never found at all. ' +
      'It is also the answer to the case the single-snapshot tools structurally cannot see: memlab_cache_analysis and memlab_growth_signals rank by SIZE on one rung, so they surface big-and-static collections and miss the small-but-unbounded one. This tool applies NO size floor — growth is the filter — because the store that matters most may hold 2 entries at the baseline. ' +
      'The signatures it emits are valid memlab_collection_trend locators: confirm a candidate, and later verify a fix, by pasting one straight in. ' +
      'Loads each rung transiently in LIGHT mode (one graph resident at a time), so it is safe on ladders too large to hold in memory at once.',
    {
      run_dir: z
        .string()
        .optional()
        .describe(
          "A leak-hunt round's output directory. Supplies the rungs and the cycle axis from run.json, instead of `paths` and `cycles`.",
        ),
      segment: segmentArg(),
      paths: z
        .array(z.string())
        .min(1)
        .optional()
        .describe(
          'Ordered snapshot paths, OLDEST FIRST (>=2). A single ["ladder:<name>"] element expands to a saved ladder (see memlab_ladder). Not needed with `run_dir`.',
        ),
      cycles: z
        .number()
        .optional()
        .describe(
          'Interaction cycles driven between the FIRST and LAST rung. When given, a Δ/cycle column is reported — the per-cycle rate is what says whether a collection scales with interaction. Read from run.json when `run_dir` is given.',
        ),
      min_growth: z
        .number()
        .optional()
        .default(20)
        .describe(
          'Only report collections whose total entry count grew by at least this across the ladder (default 20). This is a GROWTH floor, not a size floor — a collection that went 2 -> 1,260 is reported, one that sits flat at 9,356 is not.',
        ),
      limit: z
        .number()
        .optional()
        .default(30)
        .describe('Maximum number of collections to report (default 30).'),
      monotonic_only: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Only report collections that grew at EVERY rung (default false: grew-net collections are included and flagged).',
        ),
      max_file_size_mb: z
        .number()
        .optional()
        .describe('Per-file size limit override (MB).'),
      rank_by: z
        .enum(['bytes', 'entries'])
        .optional()
        .default('bytes')
        .describe(
          'Order rows (after "grew at every rung") by estimated BYTES added (default) or by entries added. Bytes surface a cache of a few large entries — 61 base64 thumbnails — that an entry ranking buries under counters with thousands of tiny ones.',
        ),
    },
    async ({
      run_dir,
      segment,
      paths,
      cycles: cyclesArg,
      min_growth,
      limit,
      monotonic_only,
      max_file_size_mb,
      rank_by,
    }) => {
      try {
        const {paths: resolved, cyclesPerRung} = resolveRunOrPaths({
          run_dir,
          segment,
          paths,
        });
        const cycles =
          cyclesArg ??
          (cyclesPerRung != null && cyclesPerRung.length >= 2
            ? cyclesPerRung[cyclesPerRung.length - 1] - cyclesPerRung[0]
            : undefined);
        if (resolved.length < 2) {
          return errorResult(
            'memlab_collection_diff needs at least 2 snapshots — it diffs collection sizes across a ladder. For a single snapshot use memlab_cache_analysis or memlab_growth_signals.',
          );
        }
        const labels: string[] = [];
        const perRung: Map<string, CollectionStat>[] = [];
        for (const p of resolved) {
          let local: string;
          let fetchedFrom: string | null = null;
          try {
            const r = resolveSnapshotPath(p);
            local = r.localPath;
            fetchedFrom = r.fetchedFrom;
          } catch (e) {
            return errorResult(
              `Failed to resolve "${p}": ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          if (!fs.existsSync(local)) {
            return errorResult(`File not found: ${local}`);
          }
          const sizeMB = fs.statSync(local).size / (1024 * 1024);
          const cap = resolveMaxFileSizeMB(
            max_file_size_mb,
            fetchedFrom != null,
          );
          if (sizeMB > cap) {
            return errorResult(
              `${p} is ${sizeMB.toFixed(0)} MB — exceeds the ${cap} MB per-file safety limit. Raise it with max_file_size_mb: ${Math.ceil(sizeMB + 100)}.`,
            );
          }
          const snapshot = await memlabUtils.getSnapshotFromFile(local, {
            buildNodeIdIndex: true,
            verbose: false,
          });
          labels.push(fetchedFrom ?? p.replace(/^.*\//, ''));
          perRung.push(censusCollections(snapshot));
        }

        reconcileModuleKeys(perRung);
        let rows = buildRows(perRung, min_growth, rank_by);
        if (monotonic_only) rows = rows.filter(r => r.monotonic);
        const shown = rows.slice(0, limit);
        const perCycle = cycles != null && cycles > 0;

        const lines: string[] = [
          `## Collection diff across ${resolved.length} rung(s)`,
          '',
        ];
        if (shown.length === 0) {
          lines.push(
            `No collection grew by ${formatNumber(min_growth)} or more entries across this ladder.`,
            '',
            '_That is a real negative for unbounded-collection growth specifically — it does not cover detached DOM, listener records, string accumulation or retained-size growth with a flat entry count. Lower `min_growth` to see smaller movers._',
          );
          return toolResult(lines.join('\n'), pathsHeader(labels));
        }

        const headers = [
          'Collection (usable as a collection_trend locator)',
          'Kind',
          ...labels.map((_, i) => `r${i}`),
          'Δ',
          ...(perCycle ? ['Δ/cycle'] : []),
          'Δ bytes (est.)',
          ...(perCycle ? ['bytes/cycle'] : []),
          'Instances',
          'Largest',
          'Trend',
        ];
        const right = new Set<number>();
        for (let i = 2; i < headers.length - 1; i++) right.add(i);
        const clip = (t: string) => (t.length > 52 ? t.slice(0, 49) + '…' : t);
        const table = shown.map(r => [
          r.moduleLabel != null
            ? `${clip(r.moduleLabel)} (\`${clip(r.locator)}\`)`
            : clip(r.sig),
          r.kind,
          ...r.series.map(v => formatNumber(v)),
          `${r.delta >= 0 ? '+' : ''}${formatNumber(r.delta)}`,
          ...(perCycle ? [(r.delta / (cycles as number)).toFixed(2)] : []),
          signedBytes(r.bytesDelta),
          ...(perCycle
            ? [signedBytes(Math.round(r.bytesDelta / (cycles as number)))]
            : []),
          `${formatNumber(r.instances[0])} → ${formatNumber(r.instances[r.instances.length - 1])}`,
          formatNumber(r.maxEntries),
          r.moduleCache
            ? '⚠ module cache, ↑ every rung'
            : r.monotonic
              ? '↑ every rung'
              : 'grew net',
        ]);
        lines.push(markdownTable(headers, table, right));

        // From every row, not just the shown ones: a small cache can rank
        // below `limit`, and this is the line that would name it.
        const caches = rows.filter(r => r.moduleCache);
        if (caches.length > 0) {
          const unshown = caches.filter(r => !shown.includes(r)).length;
          lines.push(
            '',
            `**⚠ ${formatNumber(caches.length)} module-scope collection(s) grew at every rung**${unshown > 0 ? ` (${formatNumber(unshown)} below the table's \`limit\`)` : ''} (${caches
              .slice(0, 4)
              .map(r => `\`${r.moduleLabel}\``)
              .join(
                ', ',
              )}). A module-level Map/Set that only ever grows is the classic unbounded cache, and it can matter at small counts when each entry is large. Check for an eviction or a clear() that has callers.`,
          );
        }
        const mono = shown.filter(r => r.monotonic);
        lines.push(
          '',
          `**${formatNumber(mono.length)} of ${formatNumber(shown.length)} shown grew at EVERY rung** — monotonic growth under a repeated interaction is the signature of an unbounded collection.` +
            (rows.length > shown.length
              ? ` ${formatNumber(rows.length - shown.length)} more above the growth floor were not shown (raise \`limit\`).`
              : ''),
        );
        if (mono.length > 0) {
          lines.push(
            '',
            '**Next:** confirm one with the trend tool, which measures the same collection per rung and reports owners separately from entries:',
            '```',
            `memlab_collection_trend({paths: [...], locators: [${mono
              .slice(0, 4)
              .map(r => `"${r.locator}"`)
              .join(', ')}]${perCycle ? `, cycles: ${cycles}` : ''}})`,
            '```',
            'Then `memlab_retainer_trace` the owner to name what holds it, and check whether the entries are distinct rather than one object re-added.',
          );
        }
        lines.push(
          '',
          '_Instances is the count of DISTINCT collections sharing a signature. When instances grow but the largest single collection does not, the OWNERS are accumulating, not the collection — a different fix (stop minting owners) from bounding one container._',
          '_Signatures are structural, not identities: two unrelated collections bound to the same-named field of the same-named class share a row. The `Instances` column is what exposes that._',
        );
        return toolResult(lines.join('\n'), pathsHeader(labels));
      } catch (error) {
        return errorResult(
          `Failed to diff collections: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
