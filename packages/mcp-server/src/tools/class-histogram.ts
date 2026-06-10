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
import {z} from 'zod';
import memlabCore from '@memlab/core';
import type {HeapNodeIdSet} from '@memlab/core';
const {NumericSet} = memlabCore;
import {getSnapshot, getSnapshotMetadata} from '../heap-state.js';
import {checkAnalysisDeadline} from '../analysis-budget.js';
import {
  errorResult,
  toolResult,
  formatBytes,
  formatNumber,
  markdownTable,
  truncateNodeName,
  suggestionsSuppressed,
  boundedDominatorRetainedSize,
} from '../utils.js';

export function registerClassHistogram(server: McpServer): void {
  server.tool(
    'memlab_class_histogram',
    'Show per-constructor/class instance count and total self size. Useful for identifying which types of objects dominate memory. ' +
      'By DEFAULT (`include_retained_size:false`) it returns a counts + self-size histogram in a single O(N) pass with NO dominator walk — fast and safe on snapshots with millions of nodes; rows are sorted by self size. ' +
      '⚠ Only pass `include_retained_size:true` when the user EXPLICITLY asks for dominator-aware retained sizes: that path walks the dominator tree and is the slow/memory-heavy part on large heaps. To stay tractable it then computes EXACT retained only for the heaviest `max_retained_classes` non-leaf classes (flat string/number classes are exact for free) and marks the rest with an upper-bound "~"; even so, on very large heaps with deep PromiseReaction/Context chains it can be slow and may hit the analysis time budget (returning "~" estimates) or, on older unbounded builds, time out the request entirely. ' +
      'Use min_count/min_self_size/min_retained_size to filter. Follow up with memlab_find_nodes_by_class to inspect specific classes, or memlab_retainer_trace on a sample node to see why objects are retained.',
    {
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of classes to return (default 20)'),
      min_count: z
        .number()
        .optional()
        .default(1)
        .describe('Minimum instance count to include (default 1)'),
      min_retained_size: z
        .number()
        .optional()
        .describe(
          'Minimum aggregate retained size in bytes to include. Use to filter to classes consuming significant memory (e.g., 1048576 for 1 MB). Ignored when include_retained_size is false.',
        ),
      min_self_size: z
        .number()
        .optional()
        .describe('Minimum total self size in bytes to include.'),
      node_type: z
        .string()
        .optional()
        .describe(
          'Filter by node type (e.g., "object", "closure", "string"). If omitted, all types are included.',
        ),
      include_retained_size: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Compute dominator-aware retained sizes. DEFAULT false: the histogram returns counts + self sizes in a single O(N) pass (no dominator walk, no per-node id storage), which is fast and safe on snapshots with millions of nodes, sorted by self size. Set to true ONLY when the user explicitly asks for retained sizes — it walks the dominator tree and, on very large heaps (e.g. deep PromiseReaction/Context chains), can be slow and may hit the analysis time budget (returning upper-bound "~" estimates) or, on older unbounded builds, time out the request. When true, output is sorted by retained size.',
        ),
      max_retained_classes: z
        .number()
        .optional()
        .default(64)
        .describe(
          'Cap on how many of the heaviest classes get an EXACT dominator-deduped retained size (default 64). Bounds the expensive dominator walk + id storage. Classes beyond this cap (and not leaf string/number types) show an upper-bound estimate marked "~". Raise for more exact rows at higher cost; this only matters when there are many large classes.',
        ),
      max_dominator_walk: z
        .number()
        .optional()
        .default(500)
        .describe(
          'Cap on how many steps the per-instance dominator-up-walk takes when deduping retained size (default 500). Bounds the cost on heaps with pathologically deep dominator chains (e.g. long PromiseReaction linked lists) that would otherwise make the walk super-linear. If a class has instances whose nearest in-set dominator is deeper than this, its retained size becomes an upper-bound estimate marked "~". Raise for more accuracy at higher cost.',
        ),
      suppress_suggestions: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Omit "Suggested next steps" boilerplate from the output to save tokens.',
        ),
    },
    async ({
      limit,
      min_count,
      min_retained_size,
      min_self_size,
      node_type,
      include_retained_size,
      max_retained_classes,
      max_dominator_walk,
      suppress_suggestions,
    }) => {
      try {
        const snapshot = getSnapshot();
        const meta = getSnapshotMetadata();

        // Flat strings and numbers are leaf nodes: they dominate nothing but
        // themselves, so instances never overlap on the dominator tree and a
        // raw sum of retainedSize equals the dominator-deduped value exactly.
        // (Cons/sliced strings have other node types and are NOT treated as
        // leaves.) This lets us skip the dominator walk for the millions of
        // string/number nodes that usually dominate node count.
        const LEAF_TYPES = new Set(['string', 'number']);

        // Pass 1: counts + self size + RAW retained sum per class. No per-node
        // id storage and no dominator walk — pure O(N). raw_retained is an
        // UPPER BOUND on the dominator-deduped retained (dedup only removes
        // overlap), which lets us pick exact-computation candidates cheaply.
        const classMap = new Map<
          string,
          {
            count: number;
            total_self_size: number;
            raw_retained: number;
            type: string;
          }
        >();

        snapshot.nodes.forEach(node => {
          if (node_type && node.type !== node_type) return;
          // Skip internal meta nodes
          if (node.id <= 3) return;

          const key = `${node.type}::${node.name}`;
          const entry = classMap.get(key);
          if (entry) {
            entry.count++;
            entry.total_self_size += node.self_size;
            entry.raw_retained += node.retainedSize;
          } else {
            classMap.set(key, {
              count: 1,
              total_self_size: node.self_size,
              raw_retained: node.retainedSize,
              type: node.type,
            });
          }
        });

        // Filter by cheap criteria first.
        let filtered = [...classMap.entries()].filter(
          ([, v]) => v.count >= min_count,
        );
        if (min_self_size != null) {
          filtered = filtered.filter(
            ([, v]) => v.total_self_size >= min_self_size,
          );
        }

        interface ClassRow {
          key: string;
          type: string;
          count: number;
          total_self_size: number;
          retained_size: number;
          retained_exact: boolean;
        }

        let computed: ClassRow[];
        let anyEstimate = false;

        if (!include_retained_size) {
          // Fast path: no retained size at all. O(N) total, sorted by self size.
          computed = filtered.map(([key, v]) => ({
            key,
            type: v.type,
            count: v.count,
            total_self_size: v.total_self_size,
            retained_size: v.total_self_size,
            retained_exact: false,
          }));
          computed.sort((a, b) => b.total_self_size - a.total_self_size);
        } else {
          // Pick the heaviest NON-LEAF classes (by raw retained, the upper
          // bound) to receive an exact dominator-deduped retained size. Leaf
          // (string/number) classes are already exact via raw_retained.
          const candidateKeys = filtered
            .filter(([, v]) => !LEAF_TYPES.has(v.type))
            .sort((a, b) => b[1].raw_retained - a[1].raw_retained)
            .slice(0, Math.max(0, max_retained_classes))
            .map(([key]) => key);

          // Pass 2 (only if there are candidates): collect node ids for the
          // candidate classes ONLY, so id storage is bounded to those classes
          // instead of the whole heap.
          const idsByClass = new Map<string, HeapNodeIdSet>();
          for (const key of candidateKeys)
            idsByClass.set(key, new NumericSet());
          if (idsByClass.size > 0) {
            snapshot.nodes.forEach(node => {
              if (node.id <= 3) return;
              if (node_type && node.type !== node_type) return;
              if (LEAF_TYPES.has(node.type)) return;
              const key = `${node.type}::${node.name}`;
              const set = idsByClass.get(key);
              if (set) set.add(node.id);
            });
          }

          computed = filtered.map(([key, v]) => {
            // The dominator walk below does not flow through the instrumented
            // snapshot.nodes.forEach, so check the deadline once per class to
            // bound a runaway aggregation to a single class.
            checkAnalysisDeadline();
            let retained = v.raw_retained;
            let exact = LEAF_TYPES.has(v.type);
            const ids = idsByClass.get(key);
            if (ids) {
              // Bounded dominator-up-walk (max_dominator_walk steps) instead of
              // @memlab's unbounded aggregateDominatorMetrics, so a deep
              // dominator chain can't make one class's aggregation blow up. If
              // the walk is truncated the size is an upper-bound estimate.
              const r = boundedDominatorRetainedSize(
                ids,
                snapshot,
                max_dominator_walk,
              );
              retained = r.retained;
              exact = r.exact;
            }
            if (!exact) anyEstimate = true;
            return {
              key,
              type: v.type,
              count: v.count,
              total_self_size: v.total_self_size,
              retained_size: retained,
              retained_exact: exact,
            };
          });

          if (min_retained_size != null) {
            computed = computed.filter(
              v => v.retained_size >= min_retained_size,
            );
          }
          computed.sort((a, b) => b.retained_size - a.retained_size);
        }

        // Use total heap size as the denominator for cumulative % so it
        // reflects each class's share of the entire heap, not just the
        // filtered subset.
        const totalRetainedAll = meta?.totalSize ?? 0;

        const sorted = computed.slice(0, limit);

        const headers = include_retained_size
          ? ['Class', 'Type', 'Count', 'Self Size', 'Retained Size', 'Cum %']
          : ['Class', 'Type', 'Count', 'Self Size'];
        const rightCols = include_retained_size
          ? new Set([2, 3, 4, 5])
          : new Set([2, 3]);
        let cumRetained = 0;
        let shownEstimate = false;
        const rows = sorted.map(v => {
          const rawName = v.key.split('::').slice(1).join('::');
          const name = truncateNodeName(
            rawName,
            v.type,
            Math.round(v.total_self_size / v.count),
            120,
          );
          if (!include_retained_size) {
            return [
              name,
              v.type,
              formatNumber(v.count),
              formatBytes(v.total_self_size),
            ];
          }
          cumRetained += v.retained_size;
          const cumPct =
            totalRetainedAll > 0
              ? ((cumRetained / totalRetainedAll) * 100).toFixed(1) + '%'
              : '-';
          const retainedCell = v.retained_exact
            ? formatBytes(v.retained_size)
            : `~${formatBytes(v.retained_size)}`;
          if (!v.retained_exact) shownEstimate = true;
          return [
            name,
            v.type,
            formatNumber(v.count),
            formatBytes(v.total_self_size),
            retainedCell,
            cumPct,
          ];
        });

        const lines = [
          `Class histogram (${formatNumber(classMap.size)} total classes, showing ${rows.length})`,
          '',
          markdownTable(headers, rows, rightCols),
        ];

        if (!include_retained_size) {
          lines.push(
            '',
            '_Retained size omitted (the default `include_retained_size:false`) for speed — sorted by self size. Only if the user explicitly wants dominator-aware retained sizes, re-run with `include_retained_size:true` (optionally with a high `min_self_size`/`min_count`); that path can be slow and may time out on very large heaps._',
          );
        } else if (shownEstimate || anyEstimate) {
          lines.push(
            '',
            `_Rows marked "~" show an upper-bound retained size (may double-count nested objects). A row is estimated when it is outside the heaviest ${formatNumber(max_retained_classes)} non-leaf classes (raise \`max_retained_classes\`), or when an instance's nearest dominating instance is deeper than the ${formatNumber(max_dominator_walk)}-step walk cap (raise \`max_dominator_walk\`). String/number rows are always exact._`,
          );
        }

        if (!suppress_suggestions && !suggestionsSuppressed()) {
          const highCount = sorted.filter(v => v.count >= 1000);
          if (highCount.length > 0) {
            lines.push('', '**Suggested next steps:**');
            for (const v of highCount.slice(0, 3)) {
              const name = v.key.split('::').slice(1).join('::');
              lines.push(
                `- ${formatNumber(v.count)} \`${name}\` instances — use \`memlab_find_nodes_by_class("${name}")\` to inspect, \`memlab_retainer_summary("${name}")\` to find common retainer patterns, or \`memlab_retainer_trace\` on a sample node`,
              );
            }
          }

          const highStrings = sorted.filter(
            v => v.type === 'string' && v.count >= 100,
          );
          if (highStrings.length > 0) {
            if (highCount.length === 0) {
              lines.push('', '**Suggested next steps:**');
            }
            lines.push(
              `- High string duplication detected — use \`memlab_duplicated_strings\` to find the most-duplicated string values`,
            );
          }
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
