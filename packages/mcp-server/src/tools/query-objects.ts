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
import type {IHeapEdge, IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {nodeRef, pageInfo, structuredResult} from '../structured.js';
import {getSnapshot, getSnapshotByHandle} from '../heap-state.js';
import {pageLines, paginate} from '../pagination.js';
import {
  nativeContextAttribution,
  resolveNativeContextFilter,
} from '../native-context.js';
import {retainedByParam, retainedOnlyBy} from '../retention-filters.js';
import {
  byteRangeParam,
  inByteRange,
  parseByteRange,
  type ByteRange,
} from '../byte-size.js';
import {
  clampLabel,
  clampLabelTo,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
} from '../utils.js';

type SortBy = 'retained_size' | 'self_size' | 'id';

export interface ObjectQuery {
  className?: RegExp;
  nodeType?: string;
  propertyName?: RegExp;
  isDetached?: boolean;
  selfSize: ByteRange | null;
  retainedSize: ByteRange | null;
  /** Owner per ordinal and the owner to keep (see native-context.ts). */
  realm?: {owner: Int32Array; keep: number};
  /** 1 for every ordinal retained only through the chosen retainer kind. */
  retainedOnly?: Uint8Array;
}

/** A pattern as a case-insensitive regex, or as literal text if it is not one. */
export function textPattern(source: string): {re: RegExp; literal: boolean} {
  try {
    return {re: new RegExp(source, 'i'), literal: false};
  } catch {
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {re: new RegExp(escaped, 'i'), literal: true};
  }
}

function hasMatchingProperty(node: IHeapNode, re: RegExp): boolean {
  let found = false;
  node.forEachReference((edge: IHeapEdge) => {
    if (re.test(String(edge.name_or_index))) {
      found = true;
      return {stop: true};
    }
  });
  return found;
}

/** Ordinals of every node matching `q`, cheapest tests first. */
export function matchObjects(
  snapshot: IHeapSnapshot,
  q: ObjectQuery,
): number[] {
  const out: number[] = [];
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (!inByteRange(node.self_size, q.selfSize)) return;
    if (q.realm != null && q.realm.owner[node.nodeIndex] !== q.realm.keep) {
      return;
    }
    if (q.retainedOnly != null && !q.retainedOnly[node.nodeIndex]) return;
    if (q.nodeType != null && node.type !== q.nodeType) return;
    if (q.isDetached != null && node.is_detached !== q.isDetached) return;
    if (!inByteRange(node.retainedSize, q.retainedSize)) return;
    if (q.className != null && !q.className.test(node.name)) return;
    if (q.propertyName != null && !hasMatchingProperty(node, q.propertyName)) {
      return;
    }
    out.push(node.nodeIndex);
  });
  return out;
}

function sortObjects(
  snapshot: IHeapSnapshot,
  ordinals: number[],
  sortBy: SortBy,
): Uint32Array {
  const n = ordinals.length;
  const key = new Float64Array(n);
  const id = new Float64Array(n);
  for (let i = 0; i < n; ++i) {
    const node = at(snapshot, ordinals[i]);
    id[i] = node.id;
    key[i] =
      sortBy === 'id'
        ? node.id
        : sortBy === 'self_size'
          ? node.self_size
          : node.retainedSize;
  }
  const order = Array.from({length: n}, (_, i) => i);
  // Largest first, except by id; ties always by id so pages are stable.
  order.sort((a, b) =>
    sortBy === 'id' ? id[a] - id[b] : key[b] - key[a] || id[a] - id[b],
  );
  const sorted = new Uint32Array(n);
  for (let i = 0; i < n; ++i) sorted[i] = ordinals[order[i]];
  return sorted;
}

// The last few queries per snapshot, so paging does not rescan the heap.
const MAX_CACHED = 4;
const cache = new WeakMap<IHeapSnapshot, Map<string, Uint32Array>>();
// The self-size total of a cached result, so a later page does not re-sum it.
const selfTotals = new WeakMap<Uint32Array, number>();

function cachedQuery(
  snapshot: IHeapSnapshot,
  cacheKey: string,
  run: () => Uint32Array,
): {result: Uint32Array; cached: boolean} {
  let perSnapshot = cache.get(snapshot);
  if (perSnapshot == null) {
    perSnapshot = new Map();
    cache.set(snapshot, perSnapshot);
  }
  const hit = perSnapshot.get(cacheKey);
  if (hit != null) {
    perSnapshot.delete(cacheKey);
    perSnapshot.set(cacheKey, hit);
    return {result: hit, cached: true};
  }
  const result = run();
  perSnapshot.set(cacheKey, result);
  if (perSnapshot.size > MAX_CACHED) {
    perSnapshot.delete(perSnapshot.keys().next().value as string);
  }
  return {result, cached: false};
}

// Ordinals come from a scan of the same snapshot, so every lookup hits.
function at(snapshot: IHeapSnapshot, ordinal: number): IHeapNode {
  return snapshot.nodes.get(ordinal) as IHeapNode;
}

export function registerQueryObjects(server: McpServer): void {
  server.tool(
    'memlab_query_objects',
    'Query heap objects by any combination of filters in ONE call, instead of chaining class search, node search and property inspection: class or node name (regex), node type, an outgoing property or edge name (regex), detached or not, the owning realm (`native_context`), what retains it exclusively (`retained_by`: closure contexts, detached DOM, the console, event handlers), and self / retained size ranges like "1MB-" or "10KB-1MB". ' +
      'Results are sorted (retained size by default, ties by id) and paged with `offset` / `page_size`; the last few queries are cached per snapshot, so paging does not rescan. ' +
      'Each row is a node id in the queried snapshot, ready for `memlab_get_node`, `memlab_retainer_trace` or `memlab_closure_inspection`. ' +
      'Examples: the 50 largest closures with a `callback` property (`node_type: "closure", property_name: "^callback$"`); every detached object over 1 MB (`is_detached: true, retained_size: "1MB-"`).',
    {
      handle: z
        .string()
        .optional()
        .describe('Snapshot to query (defaults to the active one).'),
      class_name: z
        .string()
        .optional()
        .describe(
          'Case-insensitive regex on the class or node name, e.g. "^Map$" or "Fiber". Text that is not a valid regex is matched literally.',
        ),
      node_type: z
        .string()
        .optional()
        .describe(
          'Exact node type: object, closure, string, array, code, native, hidden, number, synthetic, concatenated string, sliced string, symbol, bigint, regexp.',
        ),
      property_name: z
        .string()
        .optional()
        .describe(
          'Case-insensitive regex an outgoing edge name must match (property, context variable, internal field or element index).',
        ),
      is_detached: z
        .boolean()
        .optional()
        .describe('Only detached (true) or only attached (false) objects.'),
      native_context: z
        .union([z.number(), z.string()])
        .optional()
        .describe(
          'Only objects owned by this realm: a NativeContext id from memlab_native_contexts, "shared" (reached from several realms) or "unattributed".',
        ),
      retained_by: retainedByParam(),
      self_size: byteRangeParam('Self size'),
      retained_size: byteRangeParam('Retained size'),
      sort_by: z
        .enum(['retained_size', 'self_size', 'id'])
        .optional()
        .default('retained_size')
        .describe(
          'Sort order (default retained_size, largest first; id ascending).',
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe('Index of the first result to show (default 0).'),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(50)
        .describe('Results per page (default 50, at most 500).'),
      max_name_length: z
        .number()
        .int()
        .min(10)
        .optional()
        .describe(
          'Truncate node names longer than this (default 100, or the session width set with memlab_snapshots).',
        ),
    },
    async ({
      handle,
      class_name,
      node_type,
      property_name,
      is_detached,
      native_context,
      retained_by,
      self_size,
      retained_size,
      sort_by,
      offset,
      page_size,
      max_name_length,
    }) => {
      try {
        const snapshot =
          handle != null ? getSnapshotByHandle(handle) : getSnapshot();
        if (snapshot == null) {
          return errorResult(
            new Error(
              handle != null
                ? `Snapshot "${handle}" is not resident.`
                : 'No snapshot is loaded. Use memlab_load_snapshot first.',
            ),
          );
        }
        const notes: string[] = [];
        const query: ObjectQuery = {
          nodeType: node_type?.trim().toLowerCase(),
          isDetached: is_detached,
          selfSize: self_size != null ? parseByteRange(self_size) : null,
          retainedSize:
            retained_size != null ? parseByteRange(retained_size) : null,
        };
        if (native_context != null) {
          const target = resolveNativeContextFilter(snapshot, native_context);
          if ('error' in target) return errorResult(new Error(target.error));
          query.realm = {
            owner: nativeContextAttribution(snapshot).owner,
            keep: target.owner,
          };
        }
        if (retained_by != null) {
          query.retainedOnly = retainedOnlyBy(snapshot, retained_by);
        }
        if (class_name != null) {
          const p = textPattern(class_name);
          query.className = p.re;
          if (p.literal)
            notes.push(`\`class_name\` is not a valid regex; matched as text.`);
        }
        if (property_name != null) {
          const p = textPattern(property_name);
          query.propertyName = p.re;
          if (p.literal)
            notes.push(
              `\`property_name\` is not a valid regex; matched as text.`,
            );
        }
        const cacheKey = JSON.stringify([
          class_name,
          query.nodeType,
          property_name,
          is_detached,
          query.realm?.keep,
          retained_by,
          query.selfSize,
          query.retainedSize,
          sort_by,
        ]);
        const started = Date.now();
        const {result, cached} = cachedQuery(snapshot, cacheKey, () =>
          sortObjects(snapshot, matchObjects(snapshot, query), sort_by),
        );
        const total = result.length;

        let selfTotal = selfTotals.get(result);
        if (selfTotal == null) {
          selfTotal = 0;
          for (let i = 0; i < total; ++i) {
            selfTotal += at(snapshot, result[i]).self_size;
          }
          selfTotals.set(result, selfTotal);
        }
        const lines = [
          `**${formatNumber(total)} objects match**, ${formatBytes(selfTotal)} self size in total` +
            (cached
              ? ' (cached query)'
              : ` (${((Date.now() - started) / 1000).toFixed(1)} s)`),
        ];
        lines.push(...notes);

        const page = paginate<number>(result, offset, page_size);
        if (page.items.length > 0) {
          const rows = page.items.map((ordinal, i) => {
            const node = at(snapshot, ordinal);
            return [
              String(page.offset + i + 1),
              `@${node.id}`,
              node.type,
              max_name_length != null
                ? clampLabelTo(node.name, max_name_length)
                : clampLabel(node.name, 100),
              formatBytes(node.self_size),
              formatBytes(node.retainedSize),
            ];
          });
          lines.push('');
          lines.push(
            markdownTable(
              ['#', 'Id', 'Type', 'Name', 'Self', 'Retained'],
              rows,
              new Set([4, 5]),
            ),
          );
          lines.push('', ...pageLines(page));
          if (sort_by === 'retained_size') {
            lines.push(
              '_Retained sizes of rows can nest (one row may hold another), so they are not added up._',
            );
          }
        }
        return structuredResult(
          lines.join('\n'),
          {
            filters: {
              class_name,
              node_type,
              property_name,
              is_detached,
              native_context,
              retained_by,
              self_size,
              retained_size,
            },
            sort_by,
            total,
            objects: page.items.map(o => nodeRef(at(snapshot, o))),
            pagination: pageInfo(page),
          },
          {snapshot: handle},
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
