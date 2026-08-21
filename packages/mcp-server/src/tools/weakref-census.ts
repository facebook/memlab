/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * The "WeakRef without compaction" leak, which is invisible to every other tool
 * here.
 *
 * The shape: a long-lived list holds `{element: WeakRef, record: {...}}` entries.
 * The WeakRef is correct and does its job — the referent is collected on time —
 * but the RECORD and the ARRAY SLOT are strongly held and nothing ever prunes
 * the entries whose referent has gone. The collection grows forever while
 * looking like careful memory hygiene.
 *
 * Nothing existing catches it. `cache_analysis` sees a legitimately-sized
 * collection. `stale_collections` looks for detached DOM and terminal statuses,
 * not for emptied WeakRefs. A reviewer reading the code sees `WeakRef` and moves
 * on. Measured on one surface: a list at 414 entries where **476 of 481 WeakRefs
 * in the heap were empty** — about 99% dead weight, growing ~2 entries per
 * interaction with no bound.
 *
 * Emptiness is read structurally: a live `WeakRef` has an outgoing edge to its
 * referent, a cleared one has only `__proto__` / `map`. That is a fact about the
 * snapshot format, not a heuristic.
 */

const STRUCTURAL_EDGE_NAMES = new Set(['__proto__', 'map', 'constructor']);

/** True when this WeakRef's referent has already been collected. */
export function isEmptyWeakRef(node: IHeapNode): boolean {
  for (const edge of node.references) {
    const name = String(edge.name_or_index);
    if (STRUCTURAL_EDGE_NAMES.has(name)) continue;
    const t = edge.toNode;
    if (t == null || t.id <= 3) continue;
    // Anything else reachable from the WeakRef is its referent.
    if (t.name === 'WeakRef' && name === '__proto__') continue;
    return false;
  }
  return true;
}

interface HolderStat {
  shape: string;
  total: number;
  empty: number;
}

export function registerWeakRefCensus(server: McpServer): void {
  server.tool(
    'memlab_weakref_census',
    'Census every WeakRef in the heap, split LIVE vs EMPTY (referent already collected), and group by the shape of the object holding them. ' +
      'Finds the "WeakRef without compaction" leak, which no other tool here can see: a list of `{element: WeakRef, record}` entries where the WeakRef correctly lets the referent go but the RECORD and the array slot are strongly held and never pruned. The collection grows forever while looking like careful memory hygiene — memlab_cache_analysis sees a normal-sized collection, memlab_stale_collections looks for detached DOM and terminal statuses rather than emptied refs, and a code reviewer sees `WeakRef` and moves on. ' +
      'Measured on one surface: 476 of 481 WeakRefs empty (~99% dead weight) in a list growing ~2 entries per interaction with no bound. ' +
      'A holder shape more than half empty is a near-certain missing-compaction bug; the fix is a prune pass or a FinalizationRegistry.',
    {
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum holder shapes to report (default 20).'),
      min_count: z
        .number()
        .optional()
        .default(5)
        .describe('Ignore holder shapes with fewer than this many WeakRefs.'),
    },
    async ({limit, min_count}) => {
      try {
        const snapshot = getSnapshot();
        if (!snapshot) {
          return errorResult(
            'No heap snapshot loaded. Use memlab_load_snapshot first.',
          );
        }
        let total = 0;
        let empty = 0;
        const byHolder = new Map<string, HolderStat>();
        const exampleHolder = new Map<string, number>();

        snapshot.nodes.forEach((node: IHeapNode) => {
          if (node.id <= 3) return;
          if (node.name !== 'WeakRef') return;
          // The prototype/constructor nodes are also named WeakRef.
          if (node.type !== 'object') return;
          total++;
          const isEmpty = isEmptyWeakRef(node);
          if (isEmpty) empty++;
          for (const edge of node.referrers) {
            const from = edge.fromNode;
            if (from == null || from.id <= 3) continue;
            if (from.name === 'WeakRef') continue;
            const keys: string[] = [];
            for (const e2 of from.references) {
              if (e2.type !== 'property') continue;
              const n = String(e2.name_or_index);
              if (n === '__proto__') continue;
              keys.push(n);
            }
            if (keys.length === 0) continue;
            const shape = `{${keys.sort().slice(0, 8).join(', ')}}`;
            const s = byHolder.get(shape) ?? {shape, total: 0, empty: 0};
            s.total++;
            if (isEmpty) s.empty++;
            byHolder.set(shape, s);
            if (!exampleHolder.has(shape)) exampleHolder.set(shape, from.id);
            break;
          }
        });

        const lines: string[] = ['## WeakRef census', ''];
        if (total === 0) {
          lines.push('_No WeakRef objects in this snapshot._');
          return toolResult(lines.join('\n'));
        }
        lines.push(
          `**${formatNumber(total)} WeakRef(s)** — ${formatNumber(total - empty)} live, **${formatNumber(empty)} empty** (${((empty / total) * 100).toFixed(0)}% of referents already collected).`,
          '',
        );
        const rows = [...byHolder.values()]
          .filter(s => s.total >= min_count)
          .sort((a, b) => b.empty - a.empty || b.total - a.total)
          .slice(0, limit);
        if (rows.length > 0) {
          lines.push(
            markdownTable(
              ['Holder shape', 'WeakRefs', 'Empty', '% empty', 'Example'],
              rows.map(s => [
                s.shape.length > 56 ? s.shape.slice(0, 53) + '…' : s.shape,
                formatNumber(s.total),
                formatNumber(s.empty),
                `${((s.empty / s.total) * 100).toFixed(0)}%`,
                `@${exampleHolder.get(s.shape) ?? 0}`,
              ]),
              new Set([1, 2, 3]),
            ),
          );
        }
        const suspects = rows.filter(s => s.empty / s.total > 0.5);
        if (suspects.length > 0) {
          lines.push(
            '',
            `⚠ **${suspects.length} holder shape(s) are more than half empty.** The referents were collected, so the WeakRef is doing its job — but the holder objects and their slots are still strongly held, which means nothing prunes the collection. Fix with a compaction pass over the list (drop entries whose \`deref()\` is undefined) or a \`FinalizationRegistry\`.`,
            '',
            '**Next:** `memlab_retainer_trace` an example holder to find the owning collection, then `memlab_collection_trend` on that locator to confirm it is unbounded rather than merely large.',
          );
        }
        lines.push(
          '',
          '_Emptiness is read from the snapshot structure, not guessed: a live WeakRef has an outgoing edge to its referent and a cleared one has only `__proto__`/`map`. A high empty share is normal immediately after a GC and is only a defect when the HOLDER count grows with it — check that on a ladder._',
        );
        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(
          `Failed to census WeakRefs: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
