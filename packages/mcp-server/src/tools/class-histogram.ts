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
import type {IHeapNode, HeapNodeIdSet} from '@memlab/core';
const {utils, NumericSet} = memlabCore;
import {getSnapshot, getSnapshotMetadata} from '../heap-state.js';
import {
  errorResult,
  toolResult,
  formatBytes,
  formatNumber,
  markdownTable,
  truncateNodeName,
  suggestionsSuppressed,
} from '../utils.js';

export function registerClassHistogram(server: McpServer): void {
  server.tool(
    'memlab_class_histogram',
    'Show instance count and total self size per constructor/class name, sorted by aggregate retained size (dominator-aware, no double-counting). Useful for identifying which types of objects dominate memory. Use min_count or min_retained_size to filter large histograms. Follow up with memlab_find_nodes_by_class to inspect specific classes, or memlab_retainer_trace on a sample node to see why objects are retained.',
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
          'Minimum aggregate retained size in bytes to include. Use to filter to classes consuming significant memory (e.g., 1048576 for 1 MB).',
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
      suppress_suggestions,
    }) => {
      try {
        const snapshot = getSnapshot();
        const meta = getSnapshotMetadata();

        const classMap = new Map<
          string,
          {
            count: number;
            total_self_size: number;
            node_ids: HeapNodeIdSet;
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
            entry.node_ids.add(node.id);
          } else {
            classMap.set(key, {
              count: 1,
              total_self_size: node.self_size,
              node_ids: new NumericSet([node.id]),
              type: node.type,
            });
          }
        });

        // Filter by min_count and min_self_size first, then compute
        // retained sizes only for classes that pass to avoid expensive
        // dominator walks on classes we'll discard anyway.
        let filtered = [...classMap.entries()].filter(
          ([, v]) => v.count >= min_count,
        );
        if (min_self_size != null) {
          filtered = filtered.filter(
            ([, v]) => v.total_self_size >= min_self_size,
          );
        }

        // Compute dominator-aware aggregate retained size per class.
        const withRetained = filtered.map(([key, v]) => {
          const retainedSize = utils.aggregateDominatorMetrics(
            v.node_ids,
            snapshot,
            () => true,
            (node: IHeapNode) => node.retainedSize,
          );
          return {key, ...v, retained_size: retainedSize};
        });

        // Apply min_retained_size filter after dominator walk
        let afterRetainedFilter = withRetained;
        if (min_retained_size != null) {
          afterRetainedFilter = withRetained.filter(
            v => v.retained_size >= min_retained_size,
          );
        }

        // Use total heap size as the denominator for cumulative % so it
        // reflects each class's share of the entire heap, not just the
        // filtered subset.
        const totalRetainedAll = meta?.totalSize ?? 0;

        const sorted = afterRetainedFilter
          .sort((a, b) => b.retained_size - a.retained_size)
          .slice(0, limit);

        const headers = [
          'Class',
          'Type',
          'Count',
          'Self Size',
          'Retained Size',
          'Cum %',
        ];
        const rightCols = new Set([2, 3, 4, 5]);
        let cumRetained = 0;
        const rows = sorted.map(v => {
          const rawName = v.key.split('::').slice(1).join('::');
          const name = truncateNodeName(
            rawName,
            v.type,
            Math.round(v.total_self_size / v.count),
            120,
          );
          cumRetained += v.retained_size;
          const cumPct =
            totalRetainedAll > 0
              ? ((cumRetained / totalRetainedAll) * 100).toFixed(1) + '%'
              : '-';
          return [
            name,
            v.type,
            formatNumber(v.count),
            formatBytes(v.total_self_size),
            formatBytes(v.retained_size),
            cumPct,
          ];
        });

        const lines = [
          `Class histogram (${formatNumber(classMap.size)} total classes, showing ${rows.length})`,
          '',
          markdownTable(headers, rows, rightCols),
        ];

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
