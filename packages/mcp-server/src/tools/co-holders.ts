/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import memlabCore from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {cachedPathLabeler} from '../heap-families.js';
import {
  boundedDominatorRetainedSize,
  enumerateMapEntries,
  enumerateSetElements,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

const {NumericSet} = memlabCore;

// Past this many entries per collection, values are sampled from the front.
const MAX_VALUES = 50_000;
// A value held by more collections than this is ambient (a shared prototype,
// a singleton), and pairing on it would join unrelated holders.
const MAX_HOLDERS_PER_VALUE = 16;

interface Holder {
  node: IHeapNode;
  entries: number;
  /** Keys and values: what two holders are matched on. */
  signal: number[];
  /** Record values and object keys: what the holder's bytes are. */
  payload: number[];
}

function isRecord(n: IHeapNode): boolean {
  return n.id > 3 && (n.type === 'object' || n.type === 'closure');
}

/**
 * What a Map / Set / WeakMap / Array holds. Map KEYS count toward the match:
 * parallel indexes keyed by the same ids (one trace-id string per entry) hold
 * different records per key, so their values never overlap while their keys
 * are the same string nodes.
 */
function heldEntries(
  node: IHeapNode,
  keyToken: (key: IHeapNode) => number,
): Omit<Holder, 'node'> | null {
  const out: number[] = [];
  const keys: number[] = [];
  let entries = 0;
  if (node.name === 'Map' || node.name === 'WeakMap') {
    for (const e of enumerateMapEntries(node)) {
      entries++;
      if (e.value != null && isRecord(e.value)) out.push(e.value.nodeIndex);
      if (e.key.id > 3) {
        if (isRecord(e.key)) out.push(e.key.nodeIndex);
        else keys.push(keyToken(e.key));
      }
    }
  } else if (node.name === 'Set') {
    for (const v of enumerateSetElements(node)) {
      entries++;
      if (isRecord(v)) out.push(v.nodeIndex);
    }
  } else if (node.name === 'Array') {
    let backing: IHeapNode | null = null;
    for (const e of node.references) {
      if (e.type === 'element') {
        entries++;
        if (isRecord(e.toNode)) out.push(e.toNode.nodeIndex);
      } else if (String(e.name_or_index) === 'elements') {
        backing = e.toNode;
      }
    }
    for (const e of backing?.references ?? []) {
      if (e.type !== 'element') continue;
      entries++;
      if (isRecord(e.toNode)) out.push(e.toNode.nodeIndex);
    }
  } else {
    return null;
  }
  const payload = [...new Set(out)].slice(0, MAX_VALUES);
  // Each part capped on its own, so a collection with many record values
  // still keeps its keys (what parallel indexes are matched on).
  const signal = [...new Set([...payload, ...keys.slice(0, MAX_VALUES)])];
  return {entries, signal, payload};
}

function find(parent: number[], i: number): number {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
}

function retainedOf(snapshot: IHeapSnapshot, idxs: Iterable<number>): number {
  const ids = new NumericSet();
  for (const i of idxs) {
    const n = snapshot.nodes.get(i);
    if (n != null) ids.add(n.id);
  }
  return boundedDominatorRetainedSize(ids, snapshot).retained;
}

export function registerCoHolders(server: McpServer): void {
  server.tool(
    'memlab_co_holders',
    'Find collections that hold the SAME objects or are keyed by the same keys: Maps, Sets and WeakMaps (Arrays with `include_arrays`) whose keys or values overlap, grouped into clusters, with the bytes a fix would free by cutting ONE holder versus ALL of them. ' +
      'The dominator tree credits a shared population to whichever holder dominates it, so per-collection sizes mislead: three maps keyed by the same 1,325 trace ids showed 3.2 MB under one module and 28 KB under the others, while together they hold 12.6 MB. String keys match by value; a holder linked only through a field of its entries (one hop) is not matched. ' +
      'Per cluster: each holder (shortest-path owner label), its entries, how many it shares with the rest, the bytes held by it ALONE, and the union retained size (what cutting every holder frees, if nothing else holds the objects). ' +
      'For overlap between two CLASSES rather than collections, use memlab_overlap_matrix.',
    {
      min_entries: z
        .number()
        .int()
        .optional()
        .default(50)
        .describe('Ignore collections with fewer record values (default 50).'),
      min_overlap: z
        .number()
        .optional()
        .default(0.5)
        .describe(
          'Join two collections when they share at least this fraction of the smaller one (default 0.5).',
        ),
      include_arrays: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Also match Arrays (default false: module dependency lists and component prop arrays share objects by design and crowd out the caches).',
        ),
      limit: z
        .number()
        .int()
        .optional()
        .default(10)
        .describe('Clusters to show, largest union first (default 10).'),
    },
    async ({min_entries, min_overlap, include_arrays, limit}) => {
      try {
        const snapshot = getSnapshot();
        const holders: Holder[] = [];
        // String keys match by VALUE: two indexes keyed by the same trace id
        // usually hold two string objects with equal contents. Tokens sit
        // past the node index range so they never collide with an object.
        const tokens = new Map<string, number>();
        const keyToken = (key: IHeapNode): number => {
          if (!key.isString) return key.nodeIndex;
          const text = key.toStringNode()?.stringValue ?? key.name;
          let t = tokens.get(text);
          if (t == null) {
            t = snapshot.nodes.length + tokens.size;
            tokens.set(text, t);
          }
          return t;
        };
        snapshot.nodes.forEach((n: IHeapNode) => {
          if (n.type !== 'object') return;
          if (
            n.name !== 'Map' &&
            n.name !== 'Set' &&
            n.name !== 'WeakMap' &&
            !(include_arrays && n.name === 'Array')
          ) {
            return;
          }
          const held = heldEntries(n, keyToken);
          if (held != null && held.signal.length >= min_entries) {
            holders.push({node: n, ...held});
          }
        });
        // How many candidate collections hold each value, saturating.
        const holdCount = new Map<number, number>();
        for (const h of holders) {
          for (const v of h.signal) {
            holdCount.set(v, (holdCount.get(v) ?? 0) + 1);
          }
        }
        const byValue = new Map<number, number[]>();
        holders.forEach((h, hi) => {
          for (const v of h.signal) {
            const c = holdCount.get(v) ?? 0;
            if (c < 2 || c > MAX_HOLDERS_PER_VALUE) continue;
            let list = byValue.get(v);
            if (list == null) {
              list = [];
              byValue.set(v, list);
            }
            list.push(hi);
          }
        });
        const shared = new Map<string, number>();
        for (const list of byValue.values()) {
          for (let a = 0; a < list.length; a++) {
            for (let b = a + 1; b < list.length; b++) {
              const key = `${list[a]}:${list[b]}`;
              shared.set(key, (shared.get(key) ?? 0) + 1);
            }
          }
        }
        // The overlap is a fraction of what CAN be shared: ambient values
        // (held by more than MAX_HOLDERS_PER_VALUE collections) never count in
        // `shared`, so they are left out of the denominator too.
        const joinable = holders.map(
          h =>
            h.signal.filter(
              v => (holdCount.get(v) ?? 0) <= MAX_HOLDERS_PER_VALUE,
            ).length,
        );
        const parent = holders.map((_, i) => i);
        for (const [key, n] of shared) {
          const [a, b] = key.split(':').map(Number);
          const smaller = Math.min(joinable[a], joinable[b]);
          if (n >= min_overlap * smaller) {
            parent[find(parent, a)] = find(parent, b);
          }
        }
        const clusters = new Map<number, number[]>();
        holders.forEach((_, i) => {
          const r = find(parent, i);
          let list = clusters.get(r);
          if (list == null) {
            list = [];
            clusters.set(r, list);
          }
          list.push(i);
        });
        const labeler = cachedPathLabeler(snapshot);
        // Union first (it decides the order), then the per-holder figures
        // only for the clusters that are shown.
        const ranked = [...clusters.values()]
          .filter(members => members.length > 1)
          .map(members => {
            const seen = new Map<number, number>();
            const owners = new Map<number, number>();
            for (const m of members) {
              for (const v of holders[m].signal) {
                seen.set(v, (seen.get(v) ?? 0) + 1);
              }
              for (const v of holders[m].payload) {
                owners.set(v, (owners.get(v) ?? 0) + 1);
              }
            }
            const union = retainedOf(snapshot, owners.keys());
            return {members, seen, owners, union};
          })
          .sort((a, b) => b.union - a.union)
          .slice(0, limit);
        const rows = ranked.map(({members, seen, owners, union}) => {
          const detail = members.map(m => {
            const h = holders[m];
            const alone = h.payload.filter(v => owners.get(v) === 1);
            return {
              label: labeler.labelOf(h.node),
              type: h.node.name,
              id: h.node.id,
              entries: h.entries,
              sharedWithOthers: h.signal.filter(v => (seen.get(v) ?? 0) > 1)
                .length,
              aloneBytes: retainedOf(snapshot, alone),
              credited: h.node.retainedSize,
            };
          });
          return {union, objects: seen.size, detail};
        });
        if (rows.length === 0) {
          return toolResult(
            `No two collections with at least ${min_entries} record values share ${Math.round(min_overlap * 100)}% of their objects.`,
          );
        }
        const lines = [
          `## Co-holders — ${rows.length} cluster(s) of collections over the same objects`,
          '',
        ];
        rows.forEach((c, i) => {
          lines.push(
            `### ${i + 1}. ${c.detail.length} holders over ${formatNumber(c.objects)} keys/objects — union ${formatBytes(c.union)}`,
            '',
            markdownTable(
              [
                'Holder (shortest-path owner)',
                'Type',
                'Entries',
                'Keys/objects shared with the others',
                'Held by it alone',
                'Dominator credit',
              ],
              c.detail
                .sort((a, b) => b.entries - a.entries)
                .map(d => [
                  `${d.label.length > 60 ? `${d.label.slice(0, 57)}…` : d.label} @${d.id}`,
                  d.type,
                  formatNumber(d.entries),
                  formatNumber(d.sharedWithOthers),
                  formatBytes(d.aloneBytes),
                  formatBytes(d.credited),
                ]),
              new Set([2, 3, 4, 5]),
            ),
            '',
          );
        });
        lines.push(
          '_**Held by it alone** is what cutting that one holder could free; **union** is what cutting every holder in the cluster frees, unless something outside the cluster also holds the objects. **Dominator credit** is the container’s own retained size, which is where a dominator view puts the bytes, often on one holder and near zero on the rest. Verify a planned cut with memlab_what_if._',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
