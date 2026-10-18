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
import {cachedPathLabeler} from '../heap-families.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

function edgeTo(node: IHeapNode, name: string): IHeapNode | null {
  for (const e of node.references) {
    if (String(e.name_or_index) === name) return e.toNode;
  }
  return null;
}

function elementTargets(node: IHeapNode): IHeapNode[] {
  const out: IHeapNode[] = [];
  const backing = edgeTo(node, 'elements');
  for (const src of backing != null ? [node, backing] : [node]) {
    for (const e of src.references) {
      if (e.type === 'element' && e.toNode.type === 'object')
        out.push(e.toNode);
    }
  }
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

interface Group {
  label: string;
  className: string;
  example: string;
  ids: number[];
  props: number;
  header: number;
  propStore: number;
  satellites: number;
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
      'A model with ~100+ fields pays a property store of several KB per record, and a record also costs whatever per-record caches key off it, so this is the number to multiply by "records a heavy user loads". `object_cost_breakdown` is keyed by class name and reads nothing on a minified build.',
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
        .optional()
        .default(5)
        .describe('Hide types with fewer records than this (default 5).'),
    },
    async ({limit, min_models}) => {
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
            const m = edgeTo(c, '_models');
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
          const index = edgeTo(c, '_index');
          if (index != null && mine.length >= min_models) {
            const store = edgeTo(index, 'properties');
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
              };
              groups.set(key, g);
            }
            g.ids.push(m.id);
            g.props += ownPropCount(m);
            g.header += m.self_size;
            g.propStore += edgeTo(m, 'properties')?.self_size ?? 0;
            g.satellites += satelliteArrayBytes(m);
          }
        }
        const rows = [...groups.values()]
          .filter(g => g.ids.length >= min_models)
          .map(g => {
            const ret = aggregate(snapshot, g.ids);
            return {g, ret};
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
              'Total',
              'e.g. fields',
            ],
            rows.map(({g, ret}) => [
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
              formatBytes(ret),
              g.example,
            ]),
            new Set([2, 3, 4, 5, 6, 7, 8]),
          ),
        ];
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
          '_**Prop store** is the out-of-object `properties` array V8 allocates once fields overflow the object; at ~100+ fields it is most of a record. **Retained / record** is dominator-deduped and excludes what other owners share (per-record caches keyed by the record are NOT included — see memlab_cache_inventory). Multiply by the records a heavy user loads._',
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
