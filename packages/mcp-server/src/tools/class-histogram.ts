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
import {getSnapshot} from '../heap-state.js';
import {
  errorResult,
  textResult,
  formatBytes,
  formatNumber,
  markdownTable,
} from '../utils.js';

export function registerClassHistogram(server: McpServer): void {
  server.tool(
    'memlab_class_histogram',
    'Show instance count and total self size per constructor/class name, sorted by aggregate retained size (dominator-aware, no double-counting). Useful for identifying which types of objects dominate memory.',
    {
      limit: z
        .number()
        .optional()
        .default(30)
        .describe('Maximum number of classes to return (default 30)'),
      min_count: z
        .number()
        .optional()
        .default(1)
        .describe('Minimum instance count to include (default 1)'),
      node_type: z
        .string()
        .optional()
        .describe(
          'Filter by node type (e.g., "object", "closure", "string"). If omitted, all types are included.',
        ),
    },
    async ({limit, min_count, node_type}) => {
      try {
        const snapshot = getSnapshot();

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

        // Filter by min_count first, then compute retained sizes only for
        // classes that pass the filter to avoid expensive dominator walks
        // on classes we'll discard anyway.
        const filtered = [...classMap.entries()].filter(
          ([, v]) => v.count >= min_count,
        );

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

        const sorted = withRetained
          .sort((a, b) => b.retained_size - a.retained_size)
          .slice(0, limit);

        const headers = [
          'Class',
          'Type',
          'Count',
          'Self Size',
          'Retained Size',
        ];
        const rightCols = new Set([2, 3, 4]);
        const rows = sorted.map(v => {
          const name = v.key.split('::').slice(1).join('::');
          return [
            name,
            v.type,
            formatNumber(v.count),
            formatBytes(v.total_self_size),
            formatBytes(v.retained_size),
          ];
        });

        return textResult(
          `Class histogram (${formatNumber(classMap.size)} total classes, showing ${rows.length})\n\n${markdownTable(headers, rows, rightCols)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
