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
  errorResult,
  formatNumber,
  markdownTable,
  pathsHeader,
  toolResult,
} from '../utils.js';
import {countEntries} from './collection-trend.js';
import {resolveLadderPaths} from './ladder.js';
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
 */
export function collectionSignature(node: IHeapNode): string | null {
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
  return [ownerLabel, ...prefixParts, binding].join('.');
}

export interface CollectionStat {
  instances: number;
  entries: number;
  maxEntries: number;
  kinds: Set<string>;
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
    const sig = collectionSignature(node);
    if (sig == null) return;
    let s = out.get(sig);
    if (!s) {
      s = {instances: 0, entries: 0, maxEntries: 0, kinds: new Set()};
      out.set(sig, s);
    }
    s.instances++;
    s.entries += n;
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
  monotonic: boolean;
}

function buildRows(
  perRung: Map<string, CollectionStat>[],
  minGrowth: number,
): Row[] {
  const sigs = new Set<string>();
  for (const m of perRung) for (const k of m.keys()) sigs.add(k);
  const rows: Row[] = [];
  for (const sig of sigs) {
    const series = perRung.map(m => m.get(sig)?.entries ?? 0);
    const instances = perRung.map(m => m.get(sig)?.instances ?? 0);
    const delta = series[series.length - 1] - series[0];
    if (delta < minGrowth) continue;
    let monotonic = true;
    for (let i = 1; i < series.length; i++) {
      if (series[i] <= series[i - 1]) monotonic = false;
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
      monotonic,
    });
  }
  rows.sort((a, b) => {
    if (a.monotonic !== b.monotonic) return a.monotonic ? -1 : 1;
    return b.delta - a.delta;
  });
  return rows;
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
      paths: z
        .array(z.string())
        .min(1)
        .describe(
          'Ordered snapshot paths, OLDEST FIRST (>=2). A single ["ladder:<name>"] element expands to a saved ladder (see memlab_ladder).',
        ),
      cycles: z
        .number()
        .optional()
        .describe(
          'Interaction cycles driven between the FIRST and LAST rung. When given, a Δ/cycle column is reported — the per-cycle rate is what says whether a collection scales with interaction.',
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
    },
    async ({
      paths,
      cycles,
      min_growth,
      limit,
      monotonic_only,
      max_file_size_mb,
    }) => {
      try {
        const {paths: resolved} = resolveLadderPaths(paths);
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

        let rows = buildRows(perRung, min_growth);
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
          'Instances',
          'Largest',
          'Trend',
        ];
        const right = new Set<number>();
        for (let i = 2; i < headers.length - 1; i++) right.add(i);
        const table = shown.map(r => [
          r.sig.length > 52 ? r.sig.slice(0, 49) + '…' : r.sig,
          r.kind,
          ...r.series.map(v => formatNumber(v)),
          `+${formatNumber(r.delta)}`,
          ...(perCycle ? [(r.delta / (cycles as number)).toFixed(2)] : []),
          `${formatNumber(r.instances[0])} → ${formatNumber(r.instances[r.instances.length - 1])}`,
          formatNumber(r.maxEntries),
          r.monotonic ? '↑ every rung' : 'grew net',
        ]);
        lines.push(markdownTable(headers, table, right));

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
              .map(r => `"${r.sig}"`)
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
