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
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import memlabCore from '@memlab/core';
import {cachedPathLabeler} from '../heap-families.js';
import {
  boundedDominatorRetainedSize,
  enumerateMapEntries,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

function elementTargets(node: IHeapNode): IHeapNode[] {
  const out: IHeapNode[] = [];
  const backing = node.getReferenceNode('elements');
  for (const src of backing != null ? [node, backing] : [node]) {
    for (const e of src.references) {
      if (e.type === 'element' && e.toNode.type === 'object')
        out.push(e.toNode);
    }
  }
  return out;
}

// Edges followed from a record to its own strings: the out-of-object store,
// an array backing store, and the record's id object (a message key).
const ID_HOPS = /^(properties|elements|id|__x_id)$/;

/** String nodes a record reaches through its own fields, up to its id. */
function recordStrings(record: IHeapNode): number[] {
  const out: number[] = [];
  const visit = (n: IHeapNode, depth: number): void => {
    for (const e of n.references) {
      const t = e.toNode;
      if (t.isString) out.push(t.id);
      else if (depth < 3 && ID_HOPS.test(String(e.name_or_index))) {
        visit(t, depth + 1);
      }
    }
  };
  visit(record, 0);
  return out;
}

function ownPropCount(node: IHeapNode): number {
  let n = 0;
  for (const e of node.references) if (e.type === 'property') n++;
  return n;
}

/** Arrays a model holds directly or through one object hop (listener maps). */
function satelliteArrayBytes(model: IHeapNode): number {
  let bytes = 0;
  const seen = new Set<number>();
  for (const e of model.references) {
    if (e.type !== 'property') continue;
    const t = e.toNode;
    if (t.type === 'array' || t.name === 'Array') {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        bytes += t.self_size;
      }
    } else if (t.type === 'object' && t.name !== 'Map' && t.name !== 'Set') {
      for (const e2 of t.references) {
        const a = e2.toNode;
        if ((a.type === 'array' || a.name === 'Array') && !seen.has(a.id)) {
          seen.add(a.id);
          bytes += a.self_size;
        }
      }
    }
  }
  return bytes;
}

function exampleProps(node: IHeapNode): string {
  const names: string[] = [];
  for (const e of node.references) {
    if (e.type !== 'property') continue;
    const k = String(e.name_or_index);
    if (k.startsWith('$') || k === '__proto__') continue;
    names.push(k);
    if (names.length >= 3) break;
  }
  return names.join(', ');
}

const {NumericSet} = memlabCore;

interface Group {
  label: string;
  className: string;
  example: string;
  ids: number[];
  props: number;
  header: number;
  propStore: number;
  satellites: number;
  /** Values of Maps/WeakMaps keyed by this type's records. */
  cacheValues: Set<number>;
  cacheHolders: Map<string, number>;
}

/**
 * Per model type: how much one loaded record costs, and where the bytes go.
 * Built for Backbone-style collections (`{_models, _index}`), found by shape so
 * it works minified.
 */
export function registerModelCensus(server: McpServer): void {
  server.tool(
    'memlab_model_census',
    "Per MODEL TYPE in Backbone-style collections (objects carrying `_models` and `_index`, found by shape so it works minified): how many records are loaded and what ONE record costs — own property count, object header, the out-of-object PROPERTY STORE V8 allocates once an object has more fields than fit in-object, arrays the model holds (listener lists, small arrays), and the dominator-deduped retained size per record — plus the bytes of each collection's `_index` dictionary. " +
      'A record also costs whatever per-record caches key off it, so the table adds the values of Maps/WeakMaps KEYED by the records (getter memos, per-record indexes), net of what the records already retain, and projects the per-record total to `project_to` records — test accounts load a fraction of real data, and the projection is what sizes a data-proportional cache. `object_cost_breakdown` is keyed by class name and reads nothing on a minified build.',
    {
      limit: z
        .number()
        .int()
        .optional()
        .default(20)
        .describe('Model types to show (default 20).'),
      min_models: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(5)
        .describe('Hide types with fewer records than this (default 5).'),
      project_to: z
        .number()
        .int()
        .optional()
        .default(20000)
        .describe(
          'Records to project the per-record total to (default 20,000, a heavy user). Test accounts load a fraction of real data, so the projection is what sizes a data-proportional cache.',
        ),
    },
    async ({limit, min_models, project_to}) => {
      try {
        const snapshot: IHeapSnapshot = getSnapshot();
        const labeler = cachedPathLabeler(snapshot);
        const collections: IHeapNode[] = [];
        snapshot.nodes.forEach((n: IHeapNode) => {
          if (n.type !== 'object') return;
          let models = false;
          let index = false;
          for (const e of n.references) {
            if (e.type !== 'property') continue;
            if (e.name_or_index === '_models') models = true;
            else if (e.name_or_index === '_index') index = true;
          }
          if (models && index) collections.push(n);
        });
        // A model belongs to the LARGEST collection holding it; per-chat
        // sub-collections repeat records the main collection already has.
        const sized = collections
          .map(c => {
            const m = c.getReferenceNode('_models');
            return {c, models: m != null ? elementTargets(m) : []};
          })
          .sort((a, b) => b.models.length - a.models.length);
        const owner = new Map<number, number>();
        for (let i = 0; i < sized.length; i++) {
          for (const m of sized[i].models) {
            if (!owner.has(m.id)) owner.set(m.id, i);
          }
        }
        const groups = new Map<string, Group>();
        const indexRows: Array<{label: string; models: number; bytes: number}> =
          [];
        for (let i = 0; i < sized.length; i++) {
          const {c, models} = sized[i];
          const mine = models.filter(m => owner.get(m.id) === i);
          if (mine.length === 0) continue;
          const label = labeler.labelOf(c);
          const index = c.getReferenceNode('_index');
          if (index != null && mine.length >= min_models) {
            const store = index.getReferenceNode('properties');
            indexRows.push({
              label,
              models: mine.length,
              bytes: index.self_size + (store?.self_size ?? 0),
            });
          }
          for (const m of mine) {
            const key = `${label}|${m.name}`;
            let g = groups.get(key);
            if (g == null) {
              g = {
                label,
                className: m.name,
                example: exampleProps(m),
                ids: [],
                props: 0,
                header: 0,
                propStore: 0,
                satellites: 0,
                cacheValues: new Set(),
                cacheHolders: new Map(),
              };
              groups.set(key, g);
            }
            g.ids.push(m.id);
            g.props += ownPropCount(m);
            g.header += m.self_size;
            g.propStore += m.getReferenceNode('properties')?.self_size ?? 0;
            g.satellites += satelliteArrayBytes(m);
          }
        }
        // Per-record caches: Maps/WeakMaps whose KEYS are these records (a
        // getter memo per message, say). They scale with loaded data exactly
        // like the records, and nothing above counts them.
        const groupOfRecord = new Map<number, Group>();
        // A cache keyed by `msg.id.toString()` holds a string, not the record.
        // Link a string key to a record when the record reaches that string
        // and no other record does (ids are unique; "chat" is not).
        const stringOwner = new Map<number, Group | null>();
        for (const g of groups.values()) {
          if (g.ids.length < min_models) continue;
          for (const id of g.ids) {
            groupOfRecord.set(id, g);
            const rec = snapshot.getNodeById(id);
            if (rec == null) continue;
            for (const sid of new Set(recordStrings(rec))) {
              stringOwner.set(sid, stringOwner.has(sid) ? null : g);
            }
          }
        }
        snapshot.nodes.forEach((n: IHeapNode) => {
          if (n.type !== 'object' || (n.name !== 'Map' && n.name !== 'WeakMap'))
            return;
          const hits = new Map<Group, number>();
          for (const e of enumerateMapEntries(n)) {
            const g =
              groupOfRecord.get(e.key.id) ??
              (e.key.isString ? stringOwner.get(e.key.id) : undefined);
            if (g == null || e.value == null || e.value.id <= 3) continue;
            g.cacheValues.add(e.value.id);
            hits.set(g, (hits.get(g) ?? 0) + 1);
          }
          for (const [g, count] of hits) {
            if (count < min_models) continue;
            const label = labeler.labelOf(n);
            g.cacheHolders.set(label, (g.cacheHolders.get(label) ?? 0) + count);
          }
        });
        const rows = [...groups.values()]
          .filter(g => g.ids.length >= min_models)
          .map(g => {
            const ret = aggregate(snapshot, g.ids);
            // Net of what the records already retain, so a value a record
            // dominates is not counted twice.
            let cache = 0;
            if (g.cacheValues.size > 0) {
              const both = new NumericSet();
              for (const id of g.ids) both.add(id);
              for (const id of g.cacheValues) both.add(id);
              cache = Math.max(
                0,
                boundedDominatorRetainedSize(both, snapshot).retained - ret,
              );
            }
            return {g, ret, cache};
          })
          .sort((a, b) => b.ret - a.ret)
          .slice(0, limit);
        if (rows.length === 0) {
          return toolResult(
            'No Backbone-style collections (`_models` + `_index`) with enough records found.',
          );
        }
        const per = (n: number, g: Group) =>
          formatBytes(Math.round(n / g.ids.length));
        const lines = [
          `## Model census — ${formatNumber(rows.reduce((s, r) => s + r.g.ids.length, 0))} records in ${rows.length} type(s)`,
          '',
          markdownTable(
            [
              'Collection',
              'Class',
              'Records',
              'Avg props',
              'Header',
              'Prop store',
              'Arrays held',
              'Retained / record',
              'Keyed caches / record',
              'Total / record',
              `At ${formatNumber(project_to)}`,
              'Loaded total',
              'e.g. fields',
            ],
            rows.map(({g, ret, cache}) => [
              g.label.length > 50 ? `${g.label.slice(0, 47)}…` : g.label,
              g.className.length > 20
                ? `${g.className.slice(0, 17)}…`
                : g.className,
              formatNumber(g.ids.length),
              String(Math.round(g.props / g.ids.length)),
              per(g.header, g),
              per(g.propStore, g),
              per(g.satellites, g),
              per(ret, g),
              per(cache, g),
              per(ret + cache, g),
              formatBytes(((ret + cache) / g.ids.length) * project_to),
              formatBytes(ret + cache),
              g.example,
            ]),
            new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
          ),
        ];
        const cacheLines = rows
          .filter(r => r.g.cacheHolders.size > 0)
          .map(
            r =>
              `- **${r.g.label}** (${formatNumber(r.g.ids.length)} records): ` +
              [...r.g.cacheHolders.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4)
                .map(([label, n]) => `${label} (${formatNumber(n)} entries)`)
                .join(', '),
          );
        if (cacheLines.length > 0) {
          lines.push('', '### Caches keyed by the records', '', ...cacheLines);
        }
        if (indexRows.length > 0) {
          lines.push(
            '',
            '### `_index` dictionaries',
            '',
            markdownTable(
              ['Collection', 'Records', 'Index bytes'],
              indexRows
                .sort((a, b) => b.bytes - a.bytes)
                .slice(0, limit)
                .map(r => [
                  r.label,
                  formatNumber(r.models),
                  formatBytes(r.bytes),
                ]),
              new Set([1, 2]),
            ),
          );
        }
        lines.push(
          '',
          `_**Prop store** is the out-of-object \`properties\` array V8 allocates once fields overflow the object; at ~100+ fields it is most of a record. **Retained / record** is dominator-deduped and excludes what other owners share. **Keyed caches / record** is what Maps/WeakMaps keyed by the record hold beyond that (getter memos, per-record indexes). **At ${formatNumber(project_to)}** multiplies the per-record total out: a test account loads a fraction of a heavy user's data, so this is the number that sizes a data-proportional cost. Per-record figures are averages over every loaded record (one without a cache entry counts as 0), so the projection assumes the same mix._`,
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

function aggregate(snapshot: IHeapSnapshot, ids: number[]): number {
  const set = new Set(ids);
  let total = 0;
  for (const id of ids) {
    const n = snapshot.getNodeById(id);
    if (n == null) continue;
    // Count a member only if no other member dominates it.
    let d = n.dominatorNode;
    let nested = false;
    for (let hops = 0; d != null && hops < 500; hops++) {
      if (set.has(d.id)) {
        nested = true;
        break;
      }
      if (d.dominatorNode == null || d.dominatorNode.id === d.id) break;
      d = d.dominatorNode;
    }
    if (!nested) total += n.retainedSize;
  }
  return total;
}
