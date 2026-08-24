/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import memlabCore from '@memlab/core';
import {z} from 'zod';
import {
  enumerateMapEntries,
  enumerateSetElements,
  errorResult,
  formatNumber,
  markdownTable,
  pathsHeader,
  toolResult,
} from '../utils.js';
import {resolveLadderPaths} from './ladder.js';
import {resolveMaxFileSizeMB, resolveSnapshotPath} from './load-snapshot.js';

const {utils: memlabUtils} = memlabCore;

/**
 * A locator names a collection by the OWNER CLASS and the property path that
 * reaches it — `LoggerImpl.logs`, `Store.cache.entries`.
 *
 * Deliberately not a node id: ids are per-capture, so an id-keyed ladder query
 * silently tracks a different object (or nothing) at every rung, which is the
 * failure this tool exists to remove. Matching by class + path is what makes a
 * collection comparable across snapshots at all.
 */
export interface Locator {
  ownerClass: string;
  path: string[];
  raw: string;
}

export function parseLocator(spec: string): Locator {
  const parts = spec
    .split('.')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (parts.length < 2) {
    throw new Error(
      `Locator "${spec}" must be "<OwnerClass>.<property>" (optionally deeper, e.g. "Store.cache.entries").`,
    );
  }
  return {ownerClass: parts[0], path: parts.slice(1), raw: spec};
}

/**
 * Follow one named edge. Hidden-class and other internal bookkeeping edges are
 * skipped so a user property named like an internal slot still resolves; a
 * `table` / `backing_store` edge is NOT followed here because the collection
 * enumerators below do that themselves.
 */
function stepEdge(node: IHeapNode, name: string): IHeapNode | null {
  for (const edge of node.references) {
    if (edge.type === 'hidden') continue;
    if (String(edge.name_or_index) !== name) continue;
    const target = edge.toNode;
    if (target.id <= 3) return null;
    return target;
  }
  return null;
}

export function resolvePath(
  owner: IHeapNode,
  path: string[],
): IHeapNode | null {
  let cur: IHeapNode | null = owner;
  for (const seg of path) {
    if (cur == null) return null;
    cur = stepEdge(cur, seg);
  }
  return cur;
}

/**
 * Number of entries held by a collection node, by V8 kind.
 *
 * Returns null when the node is not a container — reported as "not a
 * collection" rather than as 0 entries, because those two read identically in a
 * table and mean opposite things (an empty cache vs a mistyped locator).
 */
export function countEntries(node: IHeapNode): number | null {
  const name = node.name;
  if (name === 'Map' || name === 'WeakMap') {
    return enumerateMapEntries(node).length;
  }
  if (name === 'Set' || name === 'WeakSet') {
    return enumerateSetElements(node).length;
  }
  if (name === 'Array' || node.type === 'array') {
    // Element edges hang off either the array node itself or its
    // `(object elements)` backing store, depending on the V8 elements kind, so
    // both are counted. An element lives in exactly one of the two, so summing
    // cannot double-count. (On the Chromium captures checked here the direct
    // form was used throughout; the backing-store branch is for the kinds that
    // are not, and an empty array's shared `elements` store contributes 0.)
    let n = 0;
    let backing: IHeapNode | null = null;
    for (const edge of node.references) {
      if (edge.type === 'element') n++;
      else if (String(edge.name_or_index) === 'elements') backing = edge.toNode;
    }
    if (backing != null) {
      for (const edge of backing.references) {
        if (edge.type === 'element') n++;
      }
    }
    return n;
  }
  if (node.type === 'object') {
    let n = 0;
    for (const edge of node.references) {
      if (
        edge.type === 'property' &&
        String(edge.name_or_index) !== '__proto__'
      ) {
        n++;
      }
    }
    return n;
  }
  return null;
}

export interface LocatorMeasurement {
  // How many objects of the owner class were found.
  owners: number;
  // How many of those actually resolved the whole property path.
  resolved: number;
  // Total entries summed over every resolved collection.
  entries: number;
  // Largest single collection, which is what a per-instance leak looks like
  // when the owner is a singleton but the total is spread over many.
  maxEntries: number;
  // True when at least one resolved target was not a container at all.
  nonCollection: boolean;
}

export function measureLocators(
  snapshot: IHeapSnapshot,
  locators: Locator[],
): Map<string, LocatorMeasurement> {
  const byClass = new Map<string, Locator[]>();
  for (const loc of locators) {
    const list = byClass.get(loc.ownerClass);
    if (list) list.push(loc);
    else byClass.set(loc.ownerClass, [loc]);
  }
  const out = new Map<string, LocatorMeasurement>();
  for (const loc of locators) {
    out.set(loc.raw, {
      owners: 0,
      resolved: 0,
      entries: 0,
      maxEntries: 0,
      nonCollection: false,
    });
  }
  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;
    const locs = byClass.get(node.name);
    if (!locs) return;
    for (const loc of locs) {
      const m = out.get(loc.raw);
      if (!m) continue;
      m.owners++;
      const target = resolvePath(node, loc.path);
      if (target == null) continue;
      const n = countEntries(target);
      if (n == null) {
        m.nonCollection = true;
        continue;
      }
      m.resolved++;
      m.entries += n;
      if (n > m.maxEntries) m.maxEntries = n;
    }
  });
  return out;
}

/**
 * Load each rung, measure the locators, drop the graph. Uses the LIGHT parse:
 * entry counts come from backing-store edges, so the dominator/retained-size
 * pass this tool would otherwise pay for on every rung buys nothing (measured
 * on a 380 MB capture: 18s → 8s per rung).
 */
export async function measureLadder(
  paths: string[],
  locators: Locator[],
  maxFileSizeMB?: number,
): Promise<{labels: string[]; perRung: Map<string, LocatorMeasurement>[]}> {
  const labels: string[] = [];
  const perRung: Map<string, LocatorMeasurement>[] = [];
  for (const p of paths) {
    let local: string;
    let fetchedFrom: string | null = null;
    try {
      const r = resolveSnapshotPath(p);
      local = r.localPath;
      fetchedFrom = r.fetchedFrom;
    } catch (e) {
      throw new Error(
        `Failed to resolve "${p}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!fs.existsSync(local)) throw new Error(`File not found: ${local}`);
    const sizeMB = fs.statSync(local).size / (1024 * 1024);
    const limit = resolveMaxFileSizeMB(maxFileSizeMB, fetchedFrom != null);
    if (sizeMB > limit) {
      throw new Error(
        `${p} is ${sizeMB.toFixed(0)} MB — exceeds the ${limit} MB per-file safety limit. Raise it with max_file_size_mb: ${Math.ceil(sizeMB + 100)}.`,
      );
    }
    const snapshot = await memlabUtils.getSnapshotFromFile(local, {
      buildNodeIdIndex: true,
      verbose: false,
    });
    labels.push(fetchedFrom ?? p.replace(/^.*\//, ''));
    perRung.push(measureLocators(snapshot, locators));
  }
  return {labels, perRung};
}

function trendOf(
  series: number[],
): 'up-every-rung' | 'grew-net' | 'flat-or-mixed' {
  let up = true;
  for (let i = 1; i < series.length; i++) {
    if (series[i] <= series[i - 1]) up = false;
  }
  const net = series[series.length - 1] - series[0];
  if (up && net > 0) return 'up-every-rung';
  if (net > 0) return 'grew-net';
  return 'flat-or-mixed';
}

export function registerCollectionTrend(server: McpServer): void {
  server.tool(
    'memlab_collection_trend',
    'Track named collections ACROSS a snapshot ladder: entry counts per rung, with per-cycle growth. memlab_cache_analysis, memlab_stale_collections and memlab_growth_signals all answer "how big is this collection now?" on one snapshot; the question that separates a leak from a cache that has simply filled is "did it grow at every rung, and by how much per interaction?" — which needs the ladder. ' +
      'Collections are named by OWNER CLASS and property path ("LoggerImpl.logs", "Store.cache.entries"), never by node id: ids are per-capture, so an id would track a different object at each rung. Every instance of the owner class is measured, so both a singleton\'s collection and a per-instance one are visible (totals and the largest single instance are reported separately). ' +
      'Measured examples from one hunt: undoStack 5 → 2,205, allFamiliesByID 3 → 16,367, LoggerImpl.logs 8,790 → 20,700 — all invisible to a single-snapshot view. ' +
      'Loads each rung transiently in LIGHT mode (one graph resident at a time), so it is safe on ladders too large to hold in memory at once.',
    {
      paths: z
        .array(z.string())
        .describe(
          'Ordered snapshot paths, OLDEST FIRST. A single ["ladder:<name>"] element expands to a saved ladder (see memlab_ladder).',
        ),
      locators: z
        .array(z.string())
        .describe(
          'Collections to track, as "<OwnerClass>.<property>" (deeper paths allowed: "Store.cache.entries"). The owner class is the node class name as it appears in memlab_class_histogram.',
        ),
      cycles: z
        .number()
        .optional()
        .describe(
          'Interaction cycles driven BETWEEN consecutive rungs. When given, growth is also reported per cycle — the figure that says whether a fix has to bound the collection or merely size it.',
        ),
      max_file_size_mb: z
        .number()
        .optional()
        .describe('Per-file size limit override (MB).'),
    },
    async ({paths, locators, cycles, max_file_size_mb}) => {
      try {
        const {paths: resolvedPaths, ladder} = resolveLadderPaths(paths);
        if (resolvedPaths.length < 2) {
          return errorResult(
            `memlab_collection_trend needs at least 2 snapshots; got ${resolvedPaths.length}. A trend cannot be read from one rung — use memlab_cache_analysis for a single snapshot.`,
          );
        }
        if (locators.length === 0) {
          return errorResult(
            'locators is empty — pass at least one "<OwnerClass>.<property>".',
          );
        }
        const parsed = locators.map(parseLocator);
        const effectiveCycles =
          cycles ??
          (ladder?.cycles != null && resolvedPaths.length > 1
            ? ladder.cycles / (resolvedPaths.length - 1)
            : undefined);

        const {labels, perRung} = await measureLadder(
          resolvedPaths,
          parsed,
          max_file_size_mb,
        );
        const n = perRung.length;

        const headers = [
          'Collection',
          ...labels.map(
            (l, i) => `r${i}: ${l.length > 18 ? l.slice(0, 15) + '…' : l}`,
          ),
          'Δ total',
          ...(effectiveCycles ? ['Δ/cycle'] : []),
          'Trend',
        ];
        const rows: string[][] = [];
        const notes: string[] = [];
        for (const loc of parsed) {
          const series = perRung.map(m => m.get(loc.raw)?.entries ?? 0);
          const owners = perRung.map(m => m.get(loc.raw)?.owners ?? 0);
          const resolved = perRung.map(m => m.get(loc.raw)?.resolved ?? 0);
          const net = series[n - 1] - series[0];
          const trend = trendOf(series);
          rows.push([
            loc.raw,
            ...series.map(v => formatNumber(v)),
            `${net >= 0 ? '+' : '−'}${formatNumber(Math.abs(net))}`,
            ...(effectiveCycles
              ? [
                  (net / (effectiveCycles * (n - 1))).toFixed(
                    Math.abs(net / (effectiveCycles * (n - 1))) < 10 ? 2 : 0,
                  ),
                ]
              : []),
            trend === 'up-every-rung'
              ? '↑ every rung'
              : trend === 'grew-net'
                ? '↑ net'
                : 'flat/mixed',
          ]);

          if (owners.every(o => o === 0)) {
            notes.push(
              `- ⚠ \`${loc.raw}\`: no node of class \`${loc.ownerClass}\` exists in any rung. Check the class name against \`memlab_class_histogram\` — this row's zeros mean "not found", not "empty".`,
            );
          } else if (resolved.every(r => r === 0)) {
            notes.push(
              `- ⚠ \`${loc.raw}\`: \`${loc.ownerClass}\` exists but the path \`.${loc.path.join('.')}\` never resolved to a collection. Inspect one instance with \`memlab_object_shape\`.`,
            );
          } else {
            const maxAtEnd = perRung[n - 1].get(loc.raw);
            if (maxAtEnd && maxAtEnd.resolved > 1) {
              const firstMax = perRung[0].get(loc.raw)?.maxEntries ?? 0;
              const ownersGrew =
                net > 0 && maxAtEnd.maxEntries <= firstMax * 1.2;
              notes.push(
                `- \`${loc.raw}\`: ${formatNumber(maxAtEnd.resolved)} instance(s) at the last rung; largest single collection holds ${formatNumber(maxAtEnd.maxEntries)} entries.` +
                  (ownersGrew
                    ? ` The total grew while the largest instance did not — the OWNERS are accumulating, not the collection. Track \`${loc.ownerClass}\` itself with \`memlab_sequence_analysis\`.`
                    : ''),
              );
            }
            if (maxAtEnd?.nonCollection) {
              notes.push(
                `- ⚠ \`${loc.raw}\`: at least one instance resolved to something that is not a container; those instances are excluded from the counts.`,
              );
            }
          }
        }

        const lines: string[] = [
          `## Collection trend across ${n} rung(s)`,
          '',
          markdownTable(
            headers,
            rows,
            new Set(
              headers
                .map((_, i) => i)
                .filter(i => i > 0 && i < headers.length - 1),
            ),
          ),
        ];
        if (effectiveCycles) {
          lines.push(
            '',
            `_Δ/cycle assumes ${formatNumber(Math.round(effectiveCycles))} interaction cycle(s) between consecutive rungs${cycles == null ? ' (from the saved ladder)' : ''}._`,
          );
        } else {
          lines.push(
            '',
            '_Pass `cycles` (interactions driven between rungs) to get per-cycle growth — the number that distinguishes a collection that must be BOUNDED from one that merely needs a bigger initial size._',
          );
        }
        if (notes.length > 0) lines.push('', ...notes);
        const growers = parsed.filter(loc => {
          const series = perRung.map(m => m.get(loc.raw)?.entries ?? 0);
          return trendOf(series) === 'up-every-rung';
        });
        lines.push(
          '',
          growers.length > 0
            ? `**${formatNumber(growers.length)} collection(s) grew at EVERY rung** (${growers.map(g => `\`${g.raw}\``).join(', ')}) — monotonic growth under a repeated interaction is the signature of an unbounded collection. Confirm the entries are distinct (not one object re-added) with \`memlab_map_entries\`, then \`memlab_retainer_trace\` the owner.`
            : '**No collection grew at every rung.** Net growth without monotonicity is usually a cache filling toward its cap; re-run with more rungs, or check `memlab_cache_analysis` for the cap.',
        );
        return toolResult(lines.join('\n'), pathsHeader(labels));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
