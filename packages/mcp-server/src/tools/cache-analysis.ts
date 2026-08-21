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
import type {IHeapNode, IHeapEdge} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot, getSnapshotMetadata} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  truncateNodeName,
  errorResult,
  toolResult,
  suggestionsSuppressed,
} from '../utils.js';

interface CacheEntry {
  nodeId: number;
  collectionType: string;
  entryCount: number;
  tableSlots: number;
  retainedSize: number;
  selfSize: number;
  ownerName: string;
  ownerEdge: string;
  hasWeakRefs: boolean;
  framework: string;
  classification: 'cache-like' | 'collection' | 'ring-buffer';
}

const CACHE_EDGE_RE =
  /cache|memo|store|registry|lru|dedup|pool|index|lookup|byId|byKey/i;

/**
 * Sibling property names specific enough to mark a ring buffer on their own: a
 * plain cache has no reason to track where the next slot to overwrite is.
 */
const RING_WRITE_CURSOR_PROPS = new Set([
  'localCursor',
  'writeFrom',
  'writeIndex',
  'writeCursor',
  'writePos',
  'nextSlot',
]);

/**
 * Cursor-ish names that are also carried by linked lists, queues, iterators,
 * tree-traversal state and cursor-paginated result sets. Alone they are not
 * evidence of a ring — a genuine unbounded cache whose owner happens to expose
 * `head` would be dropped as bounded — so they only count when paired with a
 * capacity control.
 */
const RING_AMBIGUOUS_CURSOR_PROPS = new Set([
  'cursor',
  'head',
  'tail',
  'nextIndex',
  'readIndex',
  'readCursor',
]);

/**
 * Anchored on purpose: an unanchored pattern matches any name merely
 * *containing* the token, so predicates and unrelated config (`hasCapacity`,
 * `overCapacity`, `defaultMaxSize`) would read as capacity controls.
 */
const RING_CAPACITY_PROP_RE =
  /^_?(?:capacity|log_?capacity|max_?size|buffer_?size|ring_?size)$/i;

/**
 * A fixed-capacity ring buffer looks exactly like an unbounded cache to a
 * size-based heuristic: a large backing array full of entries, strongly held,
 * with no eviction call in sight. It is the opposite — it can never grow.
 *
 * Observed false positive: a logger's 150,000-slot ring was reported as
 * "cache-like, missing eviction is a likely leak" because the tool counted the
 * ~11k non-null slots. Detect the shape from the owner's sibling properties (a
 * write cursor and/or a capacity control) so it is labelled bounded instead.
 *
 * Biased towards under-detection: a missed ring is a false leak candidate the
 * caller can dismiss, while a wrongly-detected one drops a real leak silently.
 */
function looksLikeRingBuffer(owner: IHeapNode | null): boolean {
  if (!owner) return false;
  let hasAmbiguousCursor = false;
  let hasCapacity = false;
  for (const edge of owner.references) {
    const name = String(edge.name_or_index);
    if (RING_WRITE_CURSOR_PROPS.has(name)) return true;
    if (RING_AMBIGUOUS_CURSOR_PROPS.has(name)) hasAmbiguousCursor = true;
    if (RING_CAPACITY_PROP_RE.test(name)) hasCapacity = true;
    if (hasAmbiguousCursor && hasCapacity) return true;
  }
  return false;
}

/**
 * Distinguish a genuine cache (named like one, owned by a cache class, or
 * carrying cache config) from a plain large collection / per-request working
 * set. Avoids over-labeling every big Map/Array as an "unbounded cache"
 * (Feedback §2c).
 */
function classifyCollection(
  collectionType: string,
  ownerEdge: string,
  framework: string,
  owner?: IHeapNode | null,
): 'cache-like' | 'collection' | 'ring-buffer' {
  // Checked first: a bounded structure is not a leak candidate however it is
  // named, and ring buffers are frequently named like caches/logs.
  if (looksLikeRingBuffer(owner ?? null)) return 'ring-buffer';
  if (framework) return 'cache-like';
  if (/cache/i.test(collectionType)) return 'cache-like';
  if (CACHE_EDGE_RE.test(ownerEdge)) return 'cache-like';
  return 'collection';
}

function identifyCacheFramework(node: IHeapNode, ownerEdge: string): string {
  // Check owner edge name for framework-specific patterns
  if (ownerEdge === '$$cache' || ownerEdge.includes('.$$cache')) {
    return 'Memoization/Selector ($$cache)';
  }
  if (ownerEdge === '__relay_store' || ownerEdge === '_recordSource') {
    return 'Relay Store';
  }
  if (ownerEdge === '_cache' || ownerEdge === '__cache') {
    return 'Module-level cache';
  }
  if (
    ownerEdge === 'atomValues' ||
    ownerEdge === 'nodeToComponentSubscriptions'
  ) {
    return 'Recoil';
  }
  if (ownerEdge === 'storeState' || ownerEdge === 'currentReducer') {
    return 'Redux';
  }

  // Check owner properties for framework hints
  if (!node.hasPathEdge) return '';
  const pathEdge = node.pathEdge;
  if (!pathEdge) return '';
  const owner = pathEdge.fromNode;

  if (owner.type === 'closure') {
    // Closures with $$cache are memoization/selector patterns
    for (const edge of owner.references) {
      const eName = String(edge.name_or_index);
      if (eName === '$$cache') return 'Memoization/Selector ($$cache)';
      if (eName === 'recoilValue') return 'Recoil selector';
    }
  }

  if (node.name === 'WeakMap') return 'WeakMap cache (no eviction risk)';

  return '';
}

function getOwnerInfo(node: IHeapNode): {
  name: string;
  edge: string;
  node?: IHeapNode;
} {
  if (!node.hasPathEdge) return {name: '(root)', edge: ''};
  const pathEdge: IHeapEdge | null = node.pathEdge;
  if (!pathEdge) return {name: '(unknown)', edge: ''};

  const from = pathEdge.fromNode;
  const edgeName = String(pathEdge.name_or_index);

  if (from.type === 'object' || from.type === 'closure') {
    return {
      name: truncateNodeName(from.name, from.type, from.self_size, 40),
      edge: edgeName,
      node: from,
    };
  }

  if (from.hasPathEdge) {
    const outerEdge: IHeapEdge | null = from.pathEdge;
    if (outerEdge) {
      const outer = outerEdge.fromNode;
      if (outer.type === 'object' || outer.type === 'closure') {
        return {
          name: truncateNodeName(outer.name, outer.type, outer.self_size, 40),
          edge: `${String(outerEdge.name_or_index)}.${edgeName}`,
          node: outer,
        };
      }
    }
  }

  return {name: from.name, edge: edgeName, node: from};
}

/**
 * O(1)-ish upper bound on a collection's entry count, used to decide whether a
 * collection is worth counting properly.
 *
 * Why it exists: `cache_analysis` gated every collection on `min_retained_size`
 * first, so a collection that is LONG but cheap — many entries of small or
 * shared values — was invisible. A positive-control Map planted for a leak hunt
 * sat under the 512 KB default and never appeared, which is the one case the
 * tool most needs to catch. Length and bytes are different questions.
 *
 * The full `countEntries` walk is O(entries), so running it on every Map/Set/
 * Array in a multi-million-node heap is not affordable. Reading the backing
 * table's `edge_count` is a single lookup and bounds the expensive walk to
 * collections that are plausibly long.
 */
function approxEntryCount(node: IHeapNode): number {
  if (node.name === 'Map' || node.name === 'Set') {
    for (const edge of node.references) {
      const eName = String(edge.name_or_index);
      if (
        (eName === 'table' || eName === 'backing_store') &&
        (edge.toNode.type === 'array' || edge.toNode.type === 'hidden')
      ) {
        const slots = edge.toNode.edge_count;
        return node.name === 'Map' ? Math.floor(slots / 2) : slots;
      }
    }
  }
  return node.edge_count;
}

function countEntries(node: IHeapNode): {entries: number; tableSlots: number} {
  if (node.name === 'Map' || node.name === 'Set') {
    for (const edge of node.references) {
      const eName = String(edge.name_or_index);
      if (
        (eName === 'table' || eName === 'backing_store') &&
        (edge.toNode.type === 'array' || edge.toNode.type === 'hidden')
      ) {
        const tableNode = edge.toNode;
        let filledSlots = 0;
        let totalSlots = 0;
        for (const e of tableNode.references) {
          if (e.type === 'internal' || e.type === 'hidden') continue;
          totalSlots++;
          const target = e.toNode;
          if (target.id <= 3) continue;
          if (target.name === 'undefined' || target.name === 'the_hole')
            continue;
          filledSlots++;
        }
        if (filledSlots === 0 && totalSlots === 0) {
          filledSlots = tableNode.edge_count;
          totalSlots = filledSlots;
        }
        const entries =
          node.name === 'Map' ? Math.floor(filledSlots / 2) : filledSlots;
        return {entries, tableSlots: filledSlots};
      }
    }
    // Fallback: count non-internal outgoing edges as a proxy for entries
    let propertyCount = 0;
    for (const edge of node.references) {
      if (edge.type === 'property' || edge.type === 'element') {
        propertyCount++;
      }
    }
    if (propertyCount > 0) {
      const entries =
        node.name === 'Map' ? Math.floor(propertyCount / 2) : propertyCount;
      return {entries, tableSlots: propertyCount};
    }
    return {entries: 0, tableSlots: 0};
  }

  const count = node.edge_count;
  return {entries: count, tableSlots: count};
}

function hasWeakRefEntries(node: IHeapNode): boolean {
  for (const edge of node.references) {
    if (edge.toNode.name === 'WeakRef' || edge.toNode.name === 'WeakMap') {
      return true;
    }
    if (edge.name_or_index === 'table' && edge.toNode.type === 'array') {
      for (const te of edge.toNode.references) {
        if (te.toNode.name === 'WeakRef') return true;
      }
    }
  }
  return false;
}

function sampleCacheEntries(
  node: IHeapNode,
  count: number,
): Array<{keyPreview: string; valuePreview: string}> {
  const entries: Array<{keyPreview: string; valuePreview: string}> = [];

  if (node.name === 'Map') {
    for (const edge of node.references) {
      if (edge.name_or_index === 'table' && edge.toNode.type === 'array') {
        const allRefs: IHeapNode[] = [];
        for (const te of edge.toNode.references) {
          allRefs.push(te.toNode);
        }
        for (let i = 0; i < allRefs.length && entries.length < count; i += 2) {
          const key = allRefs[i];
          const val = i + 1 < allRefs.length ? allRefs[i + 1] : null;
          if (key.type === 'hidden' || key.id <= 3) continue;
          const keyStr = key.isString
            ? `"${(key.toStringNode()?.stringValue ?? key.name).slice(0, 40)}"`
            : `${key.name} (${key.type})`;
          let valStr = '(missing)';
          if (val) {
            if (val.isString) {
              valStr = `"${(val.toStringNode()?.stringValue ?? val.name).slice(0, 40)}"`;
            } else {
              const props: string[] = [];
              for (const ve of val.references) {
                if (ve.type === 'property') {
                  props.push(String(ve.name_or_index));
                  if (props.length >= 8) break;
                }
              }
              const totalProps = [...val.references].filter(
                e => e.type === 'property',
              ).length;
              valStr =
                props.length > 0
                  ? `${val.name} {${props.join(', ')}${totalProps > props.length ? `, … +${totalProps - props.length} more` : ''}}`
                  : `${val.name} (${val.type}, ${formatBytes(val.retainedSize)})`;
            }
          }
          entries.push({keyPreview: keyStr, valuePreview: valStr});
        }
        break;
      }
    }
  } else if (node.name === 'Set') {
    for (const edge of node.references) {
      if (edge.name_or_index === 'table' && edge.toNode.type === 'array') {
        for (const te of edge.toNode.references) {
          if (entries.length >= count) break;
          const entry = te.toNode;
          if (entry.type === 'hidden' || entry.id <= 3) continue;
          const preview = entry.isString
            ? `"${(entry.toStringNode()?.stringValue ?? entry.name).slice(0, 40)}"`
            : `${entry.name} (${entry.type}, ${formatBytes(entry.retainedSize)})`;
          entries.push({keyPreview: preview, valuePreview: '(Set entry)'});
        }
        break;
      }
    }
  } else if (node.name === 'Array') {
    let idx = 0;
    for (const edge of node.references) {
      if (entries.length >= count) break;
      if (edge.type !== 'element') continue;
      const entry = edge.toNode;
      if (entry.id <= 3) continue;
      const preview = entry.isString
        ? `"${(entry.toStringNode()?.stringValue ?? entry.name).slice(0, 40)}"`
        : `${entry.name} (${entry.type}, ${formatBytes(entry.retainedSize)})`;
      entries.push({keyPreview: `[${idx}]`, valuePreview: preview});
      idx++;
    }
  }

  return entries;
}

export function registerCacheAnalysis(server: McpServer): void {
  server.tool(
    'memlab_cache_analysis',
    'Detect unbounded caches — Map, Set, and Array objects that are large and likely missing eviction logic. The #1 cause of Node.js memory leaks. Reports entry count, retained size, owner object, and whether entries use WeakRef. Use this after memlab_auto_investigate or memlab_check_health flags suspicious collections.',
    {
      limit: z
        .number()
        .optional()
        .default(15)
        .describe('Maximum number of caches to return (default 15)'),
      min_entries: z
        .number()
        .optional()
        .default(50)
        .describe(
          'Minimum number of entries to consider a collection a potential cache (default 50)',
        ),
      min_retained_size: z
        .number()
        .optional()
        .default(524288)
        .describe('Minimum retained size in bytes (default 512 KB)'),
      collection_types: z
        .array(z.string())
        .optional()
        .default(['Map', 'Set', 'Array'])
        .describe('Collection types to scan (default: Map, Set, Array)'),
      detect_object_caches: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Also scan for ad-hoc object caches: plain objects with TTL-cache shapes ({result,expiresAt}, {data,timestamp}, {value,ts}), objects with cache config properties (ttlMs, maxSize, retentionMs), globalThis properties retaining >1 MB, and objects with refreshTimer/inflight patterns (default true)',
        ),
      detect_identical_entries: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Compare entries within each cache for structural similarity (same array lengths, similar retained sizes). Flags caches where multiple entries appear to contain identical data — suggests caching once instead of per-key (default true)',
        ),
      sample_entries: z
        .number()
        .optional()
        .default(0)
        .describe(
          'Number of sample entries to show per cache (default 0). Inspects representative key-value pairs showing key type/preview and value shape. Saves 2-3 follow-up tool calls per cache.',
        ),
      compact_samples: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Use compact one-line format for sampled entries (default true). ' +
            'Shows "key_type → value_shape" instead of full object descriptions. ' +
            'Set to false for verbose entry details.',
        ),
      summary_only: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Headline counts and totals ONLY — no ranked table, no per-entry samples, no "long but small" section (default false). Use after the first call in a session, when the ranked table has already been read and only the totals are wanted.',
        ),
    },
    async ({
      limit,
      min_entries,
      min_retained_size,
      collection_types,
      detect_object_caches,
      detect_identical_entries,
      sample_entries,
      compact_samples,
      summary_only,
    }) => {
      try {
        const snapshot = getSnapshot();
        const meta = getSnapshotMetadata();
        const totalSize = meta?.totalSize ?? 0;

        const typeSet = new Set(collection_types);
        const caches: CacheEntry[] = [];
        // Collections that clear `min_entries` but not `min_retained_size`.
        const longButSmall: Array<{
          nodeId: number;
          collectionType: string;
          entryCount: number;
          retainedSize: number;
          ownerName: string;
        }> = [];

        snapshot.nodes.forEach(node => {
          if (node.id <= 3) return;
          if (!typeSet.has(node.name)) return;
          if (node.type !== 'object') return;
          // Size-independent path: a collection that is long enough to matter is
          // examined even when it is small in bytes (see approxEntryCount).
          const bigEnough = node.retainedSize >= min_retained_size;
          if (!bigEnough && approxEntryCount(node) < min_entries) return;

          const {entries: entryCount, tableSlots} = countEntries(node);
          if (entryCount < min_entries) return;
          if (!bigEnough) {
            // Long but cheap. Reported in its own section rather than mixed into
            // the ranked table, whose ordering and thresholds callers rely on.
            longButSmall.push({
              nodeId: node.id,
              collectionType: node.name,
              entryCount,
              retainedSize: node.retainedSize,
              ownerName: getOwnerInfo(node).name,
            });
            return;
          }

          const owner = getOwnerInfo(node);
          const framework = identifyCacheFramework(node, owner.edge);
          const entry: CacheEntry = {
            nodeId: node.id,
            collectionType: node.name,
            entryCount,
            tableSlots,
            retainedSize: node.retainedSize,
            selfSize: node.self_size,
            ownerName: owner.name,
            ownerEdge: owner.edge,
            hasWeakRefs: hasWeakRefEntries(node),
            framework,
            classification: classifyCollection(
              node.name,
              owner.edge,
              framework,
              owner.node,
            ),
          };

          let inserted = false;
          for (let i = 0; i < caches.length; i++) {
            if (entry.retainedSize > caches[i].retainedSize) {
              caches.splice(i, 0, entry);
              inserted = true;
              break;
            }
          }
          if (!inserted) caches.push(entry);
          if (caches.length > limit) caches.length = limit;
        });

        // Detect ad-hoc object caches: plain objects with cache-like shapes
        if (detect_object_caches) {
          const DATA_PROPS = new Set([
            'rows',
            'data',
            'items',
            'results',
            'result',
            'value',
            'response',
            'payload',
            // Common collection-property names on Nest/in-process TTL caches
            // that were missed before (e.g. `{entries, timestamp, map}`,
            // `{records, loadedAt}`). Feedback round 4 §B.
            'entries',
            'records',
            'nodes',
            'list',
            'cache',
          ]);
          const TIMESTAMP_PROPS = new Set([
            'timestamp',
            'cachedAt',
            'ttl',
            'expiresAt',
            'updatedAt',
            'ts',
            'ttlMs',
            'expiry',
            'createdAt',
            // Freshness markers used by load-once warm caches. `loadedAt` in
            // particular is a very common Nest pattern that was missed before.
            // Feedback round 4 §B.
            'loadedAt',
            'loaded_at',
            'cached_at',
            'fetchedAt',
            'fetched_at',
            'lastFetched',
            'lastLoaded',
            'lastUpdated',
          ]);
          const CONFIG_PROPS = new Set([
            'ttlMs',
            'maxSize',
            'retentionMs',
            'maxAge',
            'capacity',
          ]);
          const INFLIGHT_PROPS = new Set([
            'refreshTimer',
            'inflight',
            'pending',
            'refreshInterval',
          ]);

          const insertCache = (entry: CacheEntry) => {
            let inserted = false;
            for (let i = 0; i < caches.length; i++) {
              if (entry.retainedSize > caches[i].retainedSize) {
                caches.splice(i, 0, entry);
                inserted = true;
                break;
              }
            }
            if (!inserted) caches.push(entry);
            if (caches.length > limit) caches.length = limit;
          };

          snapshot.nodes.forEach(node => {
            if (node.id <= 3) return;
            if (node.type !== 'object' || node.name !== 'Object') return;
            if (node.retainedSize < min_retained_size) return;

            let hasDataProp = false;
            let hasTimestampProp = false;
            let hasConfigProp = false;
            let hasInflightProp = false;
            let dataEntryCount = 0;
            let cacheType = 'Object (ad-hoc cache)';

            for (const edge of node.references) {
              if (edge.type !== 'property') continue;
              const propName = String(edge.name_or_index);
              if (DATA_PROPS.has(propName)) {
                hasDataProp = true;
                if (
                  edge.toNode.name === 'Array' &&
                  edge.toNode.type === 'object'
                ) {
                  dataEntryCount = edge.toNode.edge_count;
                }
              }
              if (TIMESTAMP_PROPS.has(propName)) hasTimestampProp = true;
              if (CONFIG_PROPS.has(propName)) hasConfigProp = true;
              if (INFLIGHT_PROPS.has(propName)) hasInflightProp = true;
            }

            // Match any cache-like pattern
            const isTTLCache = hasDataProp && hasTimestampProp;
            const isConfiguredCache = hasDataProp && hasConfigProp;
            const isWarmCache = hasDataProp && hasInflightProp;

            if (!isTTLCache && !isConfiguredCache && !isWarmCache) return;

            if (isConfiguredCache) cacheType = 'Object (configured cache)';
            if (isWarmCache) cacheType = 'Object (warm-on-boot cache)';

            const owner = getOwnerInfo(node);
            insertCache({
              nodeId: node.id,
              collectionType: cacheType,
              entryCount: dataEntryCount,
              tableSlots: dataEntryCount,
              retainedSize: node.retainedSize,
              selfSize: node.self_size,
              ownerName: owner.name,
              ownerEdge: owner.edge,
              hasWeakRefs: false,
              framework: '',
              classification: classifyCollection(cacheType, owner.edge, ''),
            });
          });

          // Detect globalThis properties retaining >1 MB
          snapshot.nodes.forEach(node => {
            if (node.id <= 3 || node.type !== 'object') return;
            if (
              node.name !== 'Window' &&
              node.name !== 'global' &&
              node.name !== 'globalThis'
            )
              return;

            for (const edge of node.references) {
              if (edge.type !== 'property') continue;
              const target = edge.toNode;
              if (target.retainedSize < 1024 * 1024) continue;
              if (target.id <= 3) continue;

              const propName = String(edge.name_or_index);
              // Skip well-known globals
              if (
                propName.startsWith('__') &&
                (propName.endsWith('__') || propName === '__proto__')
              )
                continue;

              insertCache({
                nodeId: target.id,
                collectionType: 'Global registry',
                entryCount: target.edge_count,
                tableSlots: target.edge_count,
                retainedSize: target.retainedSize,
                selfSize: target.self_size,
                ownerName: node.name,
                ownerEdge: propName,
                hasWeakRefs: false,
                framework: '',
                classification: classifyCollection(
                  'Global registry',
                  propName,
                  '',
                ),
              });
            }
          });
        }

        // Long-but-cheap collections. Rendered as its own section so the size
        // threshold can no longer hide a growing collection outright — the
        // failure that made a planted positive-control Map invisible.
        const longButSmallSection = (): string[] => {
          if (longButSmall.length === 0) return [];
          longButSmall.sort((a, b) => b.entryCount - a.entryCount);
          const top = longButSmall.slice(0, 10);
          return [
            '',
            `### Long but small — ${formatNumber(longButSmall.length)} collection(s) with >= ${formatNumber(min_entries)} entries but under ${formatBytes(min_retained_size)} retained`,
            '',
            'These are excluded from the ranked table above by `min_retained_size`, but entry COUNT is the signal for unbounded growth — a collection that grows without bound is a leak whether or not its entries are large. Track these across a ladder.',
            '',
            markdownTable(
              ['Collection', 'Entries', 'Retained', 'Owner', 'ID'],
              top.map(c => [
                c.collectionType,
                formatNumber(c.entryCount),
                formatBytes(c.retainedSize),
                c.ownerName.length > 40
                  ? c.ownerName.slice(0, 37) + '…'
                  : c.ownerName,
                `@${c.nodeId}`,
              ]),
              new Set([1, 2]),
            ),
            ...(longButSmall.length > top.length
              ? [
                  '',
                  `_… +${formatNumber(longButSmall.length - top.length)} more. Lower \`min_retained_size\` to rank them with the rest._`,
                ]
              : []),
          ];
        };

        if (caches.length === 0) {
          return toolResult(
            [
              `No unbounded caches found with >= ${min_entries} entries and >= ${formatBytes(min_retained_size)} retained. Try lowering the thresholds.`,
              ...longButSmallSection(),
            ].join('\n'),
          );
        }

        const hasAnyFramework = caches.some(c => c.framework !== '');
        const hasSlotDifference = caches.some(
          c => c.tableSlots !== c.entryCount,
        );
        const headers = [
          'ID',
          'Type',
          'Kind',
          'Entries',
          ...(hasSlotDifference ? ['Table Slots'] : []),
          'Retained',
          '% Heap',
          'Owner',
          'Property',
          'Weak?',
          ...(hasAnyFramework ? ['Framework'] : []),
        ];
        const rightCols = hasSlotDifference
          ? new Set([3, 4, 5, 6])
          : new Set([3, 4, 5]);
        const rows = caches.map(c => {
          const pct =
            totalSize > 0
              ? ((c.retainedSize / totalSize) * 100).toFixed(1) + '%'
              : '-';
          return [
            `@${c.nodeId}`,
            c.collectionType,
            c.classification,
            formatNumber(c.entryCount),
            ...(hasSlotDifference ? [formatNumber(c.tableSlots)] : []),
            formatBytes(c.retainedSize),
            pct,
            c.ownerName,
            c.ownerEdge,
            c.hasWeakRefs ? 'Yes' : 'No',
            ...(hasAnyFramework ? [c.framework || '-'] : []),
          ];
        });

        const totalRetained = caches.reduce(
          (sum, c) => sum + c.retainedSize,
          0,
        );
        const cacheLike = caches.filter(
          c => c.classification === 'cache-like',
        ).length;

        if (summary_only) {
          return toolResult(
            [
              `Cache analysis: ${caches.length} large collection(s) (${cacheLike} cache-like, ${caches.length - cacheLike} plain collection/working-set), ${formatBytes(totalRetained)} total retained`,
              '',
              `Largest: \`${caches[0].ownerName}\` — ${formatNumber(caches[0].entryCount)} entries, ${formatBytes(caches[0].retainedSize)}.`,
              '',
              `_summary_only: the ${formatNumber(rows.length)}-row ranked table and the per-entry samples are withheld. Re-run with \`summary_only: false\` for them._`,
            ].join('\n'),
          );
        }

        const lines = [
          `Cache analysis: ${caches.length} large collection(s) (${cacheLike} cache-like, ${caches.length - cacheLike} plain collection/working-set), ${formatBytes(totalRetained)} total retained`,
          '',
          markdownTable(headers, rows, rightCols),
          '',
          '**Kind:**',
          '- **cache-like** — named like a cache, owned by a cache class, or carrying TTL/maxSize config. Missing eviction here is a likely leak.',
          '- **collection** — a plain large Map/Set/Array or per-request working set. Large is not the same as leaking; confirm it is actually retained across requests before treating it as a leak.',
          '- **ring-buffer** — fixed-capacity buffer (the owner carries a write cursor and/or a capacity control). It looks like an unbounded cache to a size heuristic but cannot grow: **not a leak candidate**. Check the declared capacity before spending time on it.',
          '',
          '**Risk indicators:**',
          '- **Weak? = No** means entries are strongly held and will never be evicted by GC',
          '- High entry count with no eviction suggests unbounded growth',
          '- Check if the owner has `clear()`, `delete()`, or LRU logic',
        ];

        if (!suggestionsSuppressed()) {
          const top = caches[0];
          lines.push(
            '',
            '**Suggested next steps:**',
            `- Inspect largest cache: \`memlab_object_shape(${top.nodeId})\``,
            `- See what it retains: \`memlab_dominator_subtree(${top.nodeId})\``,
            `- Trace its retainer: \`memlab_retainer_trace(${top.nodeId})\``,
            `- Check for common patterns: \`memlab_retainer_summary\` with node_ids from the top caches`,
          );
        }

        // Detect byte-tracking mismatch and extract cache config (Feedback #2, #10)
        const SIZE_PROPS = new Set([
          'bytes',
          'size',
          'currentSize',
          'currentBytes',
          'maxBytes',
          'byteSize',
          'totalSize',
        ]);
        const DISPLAY_CONFIG_PROPS = new Set([
          'maxBytes',
          'ttlMs',
          'maxSize',
          'maxAge',
          'capacity',
          'layer',
          'name',
          'namespace',
          'maxEntries',
          'ttl',
        ]);
        const mismatchAlerts: string[] = [];
        const configAlerts: string[] = [];

        for (const c of caches.slice(0, 15)) {
          const node = snapshot.getNodeById(c.nodeId);
          if (!node) continue;

          let selfReportedSize = -1;
          let selfReportedProp = '';
          const configPairs: Array<{key: string; value: string}> = [];

          const scanNode = (n: typeof node) => {
            for (const edge of n.references) {
              if (edge.type !== 'property') continue;
              const eName = String(edge.name_or_index);
              const target = edge.toNode;

              if (
                SIZE_PROPS.has(eName) &&
                selfReportedSize < 0 &&
                (target.type === 'number' ||
                  (target.type === 'hidden' &&
                    target.name === 'system / HeapNumber'))
              ) {
                selfReportedSize =
                  target.self_size === 0 ? 0 : target.self_size;
                selfReportedProp = eName;
              }

              if (DISPLAY_CONFIG_PROPS.has(eName)) {
                let val: string;
                if (target.isString) {
                  const s = target.toStringNode();
                  val = s ? `"${s.stringValue.slice(0, 30)}"` : target.name;
                } else if (
                  target.type === 'number' ||
                  (target.type === 'hidden' &&
                    target.name === 'system / HeapNumber')
                ) {
                  val =
                    target.self_size === 0
                      ? 'smi'
                      : formatBytes(target.self_size);
                } else {
                  val = target.name;
                }
                configPairs.push({key: eName, value: val});
              }
            }
          };

          scanNode(node);
          // Also check owner object for config props
          if (node.hasPathEdge) {
            const pathEdge = node.pathEdge;
            if (pathEdge) scanNode(pathEdge.fromNode);
          }

          if (
            selfReportedSize >= 0 &&
            c.retainedSize > selfReportedSize * 5 &&
            c.retainedSize > 1024 * 1024
          ) {
            mismatchAlerts.push(
              `⚠️ **@${c.nodeId} \`${c.collectionType}\`:** self-reported \`${selfReportedProp}\` tracks ~${formatBytes(selfReportedSize)} but actual retained size is **${formatBytes(c.retainedSize)}** (${Math.round(c.retainedSize / Math.max(selfReportedSize, 1))}×). The cache likely tracks serialized/compressed size but stores deserialized V8 objects that consume far more heap.`,
            );
          }

          if (configPairs.length > 0) {
            const configStr = configPairs
              .map(p => `${p.key}=${p.value}`)
              .join(', ');
            configAlerts.push(
              `- @${c.nodeId} \`${c.collectionType}\`: ${configStr}`,
            );
          }
        }

        if (mismatchAlerts.length > 0) {
          lines.push(
            '',
            '---',
            '',
            '## Byte-Tracking Mismatch',
            '',
            'Caches where the self-reported size property significantly underestimates actual heap retention:',
            '',
          );
          lines.push(...mismatchAlerts);
          lines.push(
            '',
            '_This happens when a cache tracks serialized/compressed blob size but stores deserialized V8 objects. Fix: track retained object count or V8 heap cost instead of blob bytes._',
          );
        }

        if (configAlerts.length > 0) {
          lines.push('', '---', '', '## Cache Configuration', '');
          lines.push(...configAlerts);
          lines.push('');
        }

        if (sample_entries > 0) {
          lines.push('', '---', '');
          for (const c of caches.slice(0, 5)) {
            const node = snapshot.getNodeById(c.nodeId);
            if (!node) continue;
            const samples = sampleCacheEntries(node, sample_entries);
            if (samples.length === 0) continue;
            lines.push(
              `**@${c.nodeId} \`${c.collectionType}\` sample entries (${samples.length} of ${formatNumber(c.entryCount)}):**`,
            );
            if (compact_samples) {
              for (const s of samples) {
                const compactKey =
                  s.keyPreview.length > 30
                    ? s.keyPreview.slice(0, 27) + '...'
                    : s.keyPreview;
                const compactVal =
                  s.valuePreview.length > 50
                    ? s.valuePreview.slice(0, 47) + '...'
                    : s.valuePreview;
                lines.push(`  - ${compactKey} → ${compactVal}`);
              }
            } else {
              for (const s of samples) {
                lines.push(`  - ${s.keyPreview} → ${s.valuePreview}`);
              }
            }
            lines.push('');
          }
        }

        // Detect structurally identical cache entries
        if (detect_identical_entries) {
          const identicalAlerts: string[] = [];

          for (const c of caches.slice(0, 10)) {
            if (c.collectionType === 'Global registry') continue;
            const node = snapshot.getNodeById(c.nodeId);
            if (!node) continue;
            if (c.collectionType !== 'Map' && c.collectionType !== 'Set')
              continue;

            // Sample entries and compare structural fingerprints
            const entryFingerprints: Array<{
              arrayLength: number;
              retainedSize: number;
              childCount: number;
            }> = [];

            for (const edge of node.references) {
              if (
                edge.name_or_index !== 'table' ||
                edge.toNode.type !== 'array'
              )
                continue;

              const allRefs: IHeapNode[] = [];
              for (const te of edge.toNode.references) {
                allRefs.push(te.toNode);
              }

              // For Maps: entries are key-value pairs
              const step = c.collectionType === 'Map' ? 2 : 1;
              const valOffset = c.collectionType === 'Map' ? 1 : 0;

              for (
                let i = valOffset;
                i < allRefs.length && entryFingerprints.length < 10;
                i += step
              ) {
                const val = allRefs[i];
                if (val.id <= 3 || val.type === 'hidden') continue;
                if (val.name === 'undefined' || val.name === 'the_hole')
                  continue;

                let arrayLength = -1;
                let childCount = 0;
                for (const ve of val.references) {
                  childCount++;
                  if (
                    ve.type === 'property' &&
                    ve.toNode.name === 'Array' &&
                    ve.toNode.type === 'object'
                  ) {
                    arrayLength = ve.toNode.edge_count;
                  }
                }

                entryFingerprints.push({
                  arrayLength,
                  retainedSize: val.retainedSize,
                  childCount,
                });
              }
              break;
            }

            if (entryFingerprints.length < 2) continue;

            // Check if entries are structurally similar
            const ref = entryFingerprints[0];
            let identicalCount = 0;
            const sizeThreshold = ref.retainedSize * 0.1; // 10% tolerance

            for (let i = 1; i < entryFingerprints.length; i++) {
              const fp = entryFingerprints[i];
              const sizeSimilar =
                Math.abs(fp.retainedSize - ref.retainedSize) < sizeThreshold;
              const structSimilar =
                fp.arrayLength === ref.arrayLength &&
                fp.arrayLength > 0 &&
                fp.childCount === ref.childCount;

              if (sizeSimilar && structSimilar) {
                identicalCount++;
              }
            }

            if (
              identicalCount >= 2 ||
              (entryFingerprints.length <= 5 &&
                identicalCount === entryFingerprints.length - 1)
            ) {
              const totalIdentical = identicalCount + 1;
              const perEntry = ref.retainedSize;
              identicalAlerts.push(
                `⚠️ **@${c.nodeId} \`${c.collectionType}\`:** ${totalIdentical} entries appear structurally identical (~${formatBytes(perEntry)} each, array length ${ref.arrayLength}). ` +
                  `Consider caching once instead of per-key — potential savings: ~${formatBytes(perEntry * (totalIdentical - 1))}.`,
              );
            }
          }

          if (identicalAlerts.length > 0) {
            lines.push(
              '',
              '---',
              '',
              '## Identical Cache Entries Detected',
              '',
            );
            lines.push(...identicalAlerts);
            lines.push(
              '',
              '_Entries have matching array lengths, child counts, and retained sizes. The cache key may not affect the cached data — consider deduplicating._',
            );
          }
        }

        lines.push(...longButSmallSection());
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
