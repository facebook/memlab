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
import type {IHeapNode} from '@memlab/core';
const {utils} = memlabCore;
import {getSnapshot} from '../heap-state.js';
import {
  errorResult,
  textResult,
  formatBytes,
  formatNumber,
  markdownTable,
} from '../utils.js';

interface GroupStats {
  count: number;
  sum_self_size: number;
  node_ids: Set<number>;
}

function getGroupKey(
  node: {name: string; type: string},
  groupBy: 'type' | 'name' | 'name_prefix',
): string {
  switch (groupBy) {
    case 'type':
      return node.type;
    case 'name':
      return node.name;
    case 'name_prefix': {
      const spaceIdx = node.name.indexOf(' ');
      return spaceIdx > 0 ? node.name.substring(0, spaceIdx) : node.name;
    }
  }
}

export function registerAggregateNodes(server: McpServer): void {
  server.tool(
    'memlab_aggregate',
    'Aggregate heap nodes by type, name, or name prefix. Returns grouped statistics (count, total self size, aggregate retained size) sorted by retained size. Retained size uses dominator-aware aggregation (no double-counting).',
    {
      name_pattern: z
        .string()
        .optional()
        .describe('Regex pattern to match against node names'),
      type: z.string().optional().describe('Node type filter'),
      min_retained_size: z
        .number()
        .optional()
        .describe('Minimum retained size in bytes'),
      min_self_size: z
        .number()
        .optional()
        .describe('Minimum self (shallow) size in bytes'),
      is_detached: z
        .boolean()
        .optional()
        .describe('Filter by detachment status'),
      group_by: z
        .enum(['type', 'name', 'name_prefix'])
        .describe(
          'What to group on: "type" (node type), "name" (full name), "name_prefix" (first word of name)',
        ),
      metrics: z
        .array(z.enum(['count', 'sum_self_size', 'retained_size']))
        .optional()
        .default(['count', 'sum_self_size', 'retained_size'])
        .describe('Metrics to compute per group'),
      limit: z
        .number()
        .optional()
        .default(30)
        .describe('Maximum number of groups to return (default 30)'),
    },
    async ({
      name_pattern,
      type,
      min_retained_size,
      min_self_size,
      is_detached,
      group_by,
      metrics,
      limit,
    }) => {
      try {
        const snapshot = getSnapshot();
        const nameRegex = name_pattern ? new RegExp(name_pattern, 'i') : null;
        const groups = new Map<string, GroupStats>();

        snapshot.nodes.forEach(node => {
          if (node.id <= 3) return;
          if (type && node.type !== type) return;
          if (nameRegex && !nameRegex.test(node.name)) return;
          if (min_retained_size && node.retainedSize < min_retained_size)
            return;
          if (min_self_size && node.self_size < min_self_size) return;
          if (is_detached !== undefined) {
            const detached =
              node.is_detached || node.name.startsWith('Detached ');
            if (is_detached !== detached) return;
          }

          const key = getGroupKey(node, group_by);
          let stats = groups.get(key);
          if (!stats) {
            stats = {count: 0, sum_self_size: 0, node_ids: new Set()};
            groups.set(key, stats);
          }
          stats.count++;
          stats.sum_self_size += node.self_size;
          stats.node_ids.add(node.id);
        });

        const metricsSet = new Set(metrics);
        const needsRetained = metricsSet.has('retained_size');

        // Compute dominator-aware aggregate retained size per group.
        const entries = Array.from(groups.entries()).map(([key, stats]) => {
          const retainedSize = needsRetained
            ? utils.aggregateDominatorMetrics(
                stats.node_ids,
                snapshot,
                () => true,
                (node: IHeapNode) => node.retainedSize,
              )
            : 0;
          return {key, ...stats, retained_size: retainedSize};
        });

        const sorted = entries
          .sort(
            (a, b) =>
              b.retained_size - a.retained_size ||
              b.sum_self_size - a.sum_self_size,
          )
          .slice(0, limit);

        const headers: string[] = [
          group_by === 'type'
            ? 'Type'
            : group_by === 'name'
              ? 'Name'
              : 'Name Prefix',
        ];
        if (metricsSet.has('count')) headers.push('Count');
        if (metricsSet.has('sum_self_size')) headers.push('Self Size');
        if (metricsSet.has('retained_size')) headers.push('Retained Size');

        const rightCols = new Set<number>();
        for (let i = 1; i < headers.length; i++) rightCols.add(i);

        const rows = sorted.map(stats => {
          const row: string[] = [stats.key];
          if (metricsSet.has('count')) row.push(formatNumber(stats.count));
          if (metricsSet.has('sum_self_size'))
            row.push(formatBytes(stats.sum_self_size));
          if (metricsSet.has('retained_size'))
            row.push(formatBytes(stats.retained_size));
          return row;
        });

        return textResult(
          `Aggregation by ${group_by} (${formatNumber(groups.size)} groups, showing ${rows.length})\n\n${markdownTable(headers, rows, rightCols)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
