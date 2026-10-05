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
 * Module-level caches an app could drop under memory pressure.
 *
 * "Which other caches could be cleared when memory is high?" took one
 * investigation four tools and a code search per candidate: find module-scope
 * collections, size what their ENTRIES hold (not the container), name the
 * owning module, look at what the entries are, and check whether the module
 * already exports something that clears it. This is that join.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {entriesRetainedOf} from './cache-analysis.js';
import {countEntries} from './collection-trend.js';
import {cachedModuleScopes} from './module-attribution.js';
import {
  enumerateMapEntries,
  enumerateSetElements,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

const COLLECTIONS = new Set(['Map', 'Set', 'Array', 'WeakMap']);
const CLEAR_NAME = /^(clear|reset|purge|evict|flush|invalidate|drop|trim)/i;

/** Element targets of an Array, on the node or on its `elements` store. */
function arrayElements(node: IHeapNode, limit: number): IHeapNode[] {
  const out: IHeapNode[] = [];
  let backing: IHeapNode | null = null;
  for (const e of node.references) {
    if (e.type === 'element') {
      if (out.length < limit) out.push(e.toNode);
    } else if (String(e.name_or_index) === 'elements') backing = e.toNode;
  }
  if (backing != null) {
    for (const e of backing.references) {
      if (out.length >= limit) break;
      if (e.type === 'element') out.push(e.toNode);
    }
  }
  return out;
}

function topTypes(vals: Array<IHeapNode | null>): string {
  const counts = new Map<string, number>();
  for (const v of vals) {
    // Oddballs and heap numbers are nodes; only an SMI has no value edge.
    const k = v == null ? 'smi' : v.isString ? 'string' : v.name || v.type;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => k)
    .join(', ');
}

function sampleTypes(node: IHeapNode): string {
  if (node.name === 'Map' || node.name === 'WeakMap') {
    const entries = enumerateMapEntries(node).slice(0, 50);
    // All-SMI values say nothing about what the map is keyed by, which is
    // what identifies a cache.
    return entries.length > 0 && entries.every(e => e.value == null)
      ? `smi, keyed by ${topTypes(entries.map(e => e.key))}`
      : topTypes(entries.map(e => e.value));
  }
  return topTypes(
    node.name === 'Set'
      ? enumerateSetElements(node).slice(0, 50)
      : arrayElements(node, 50),
  );
}

export function registerCacheInventory(server: McpServer): void {
  server.tool(
    'memlab_cache_inventory',
    "Inventory of MODULE-SCOPE collections (Map / Set / WeakMap / Array held directly by a Haste module's scope), ranked by what their entries hold: owning module, variable name, entry count, entries-retained (dominator-deduped, so values also held elsewhere still count), what the entries are, and whether the module already has a clear/reset/purge/evict function — the candidates an app could drop under memory pressure, in one call.",
    {
      min_bytes: z
        .number()
        .optional()
        .default(65536)
        .describe('Hide collections holding less than this (default 64 KB).'),
      limit: z.number().optional().default(25).describe('Rows (default 25).'),
    },
    async ({min_bytes, limit}) => {
      try {
        const snapshot = getSnapshot();
        // Keyed by BOTH ids of each module: its module record and its
        // `system / Context` scope. The first pass reads records, the second
        // scopes.
        const scopes = cachedModuleScopes(snapshot);
        // Clear functions a module EXPORTS live on its record's
        // exports / defaultExport, not in its scope.
        const exportedClears = new Map<string, string[]>();
        for (const [id, module] of scopes) {
          const record = snapshot.getNodeById(id);
          if (record == null || record.name.startsWith('system / Context'))
            continue;
          const names: string[] = [];
          for (const re of record.references) {
            const k = String(re.name_or_index);
            if (k !== 'exports' && k !== 'defaultExport') continue;
            for (const pe of re.toNode.references) {
              const n = String(pe.name_or_index);
              if (
                pe.type === 'property' &&
                pe.toNode.type === 'closure' &&
                CLEAR_NAME.test(n)
              ) {
                names.push(n);
              }
            }
          }
          if (names.length > 0) {
            exportedClears.set(module, [
              ...new Set([...(exportedClears.get(module) ?? []), ...names]),
            ]);
          }
        }
        const rows: Array<{
          module: string;
          name: string;
          kind: string;
          entries: number | null;
          held: number;
          exact: boolean;
          types: string;
          clear: string[];
          id: number;
        }> = [];
        for (const [id, module] of scopes) {
          const scope = snapshot.getNodeById(id);
          if (scope == null || !scope.name.startsWith('system / Context'))
            continue;
          const clear: string[] = [...(exportedClears.get(module) ?? [])];
          const cols: Array<{name: string; node: IHeapNode}> = [];
          for (const e of scope.references) {
            if (e.type !== 'context') continue;
            const name = String(e.name_or_index);
            const t = e.toNode;
            if (
              t.type === 'closure' &&
              CLEAR_NAME.test(name) &&
              !clear.includes(name)
            ) {
              clear.push(name);
            }
            if (t.type === 'object' && COLLECTIONS.has(t.name))
              cols.push({name, node: t});
          }
          for (const {name, node} of cols) {
            const measured = entriesRetainedOf(node, snapshot);
            const held = Math.max(node.retainedSize, measured?.retained ?? 0);
            if (held < min_bytes) continue;
            rows.push({
              module,
              name,
              kind: node.name,
              entries: countEntries(node),
              held,
              exact: measured?.exact ?? true,
              types: sampleTypes(node),
              clear,
              id: node.id,
            });
          }
        }
        rows.sort((a, b) => b.held - a.held);
        if (rows.length === 0) {
          return toolResult(
            `No module-scope collection holds ${formatBytes(min_bytes)} or more. Lower \`min_bytes\`, or check that the app is a Haste bundle (\`memlab_module_attribution\` reports how many module scopes were matched).`,
          );
        }
        return toolResult(
          [
            `## Module-scope caches — ${formatNumber(rows.length)} at or above ${formatBytes(min_bytes)}` +
              (rows.length > limit ? ` (top ${limit} shown)` : ''),
            '',
            markdownTable(
              [
                'Module',
                'Variable',
                'Kind',
                'Entries',
                'Held',
                'Entries are',
                'Clear API in module',
                'ID',
              ],
              rows
                .slice(0, limit)
                .map(r => [
                  r.module.length > 60 ? r.module.slice(0, 57) + '…' : r.module,
                  r.name,
                  r.kind,
                  r.entries != null ? formatNumber(r.entries) : '—',
                  `${r.exact ? '' : '≥'}${formatBytes(r.held)}`,
                  r.types || '—',
                  r.clear.join(', ') || '—',
                  `@${r.id}`,
                ]),
              new Set([3, 4]),
            ),
            '',
            '_**Held** is the larger of what the collection alone dominates and what its entries retain. A row with a clear API is a cheap memory-pressure hook; one without needs the owning module to grow one. Check the module source before wiring either: a cache that is cleared may simply be refilled on the next render._',
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
