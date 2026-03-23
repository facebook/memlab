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
import memlabCore from '@memlab/core';
import type {IHeapNode} from '@memlab/core';
const {utils} = memlabCore;
import {getSnapshot, getFilePath} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  textResult,
} from '../utils.js';

export function registerSnapshotSummary(server: McpServer): void {
  server.tool(
    'memlab_snapshot_summary',
    'Get an overview of the loaded heap snapshot: total nodes, edges, size, and breakdown by node type with count, self size, and aggregate retained size (dominator-aware, no double-counting).',
    {},
    async () => {
      try {
        const snapshot = getSnapshot();

        let nodeCount = 0;
        let edgeCount = 0;
        let totalSelfSize = 0;
        const typeStats = new Map<
          string,
          {count: number; self_size: number; node_ids: Set<number>}
        >();

        snapshot.nodes.forEach(node => {
          nodeCount++;
          totalSelfSize += node.self_size;
          let stats = typeStats.get(node.type);
          if (!stats) {
            stats = {count: 0, self_size: 0, node_ids: new Set()};
            typeStats.set(node.type, stats);
          }
          stats.count++;
          stats.self_size += node.self_size;
          stats.node_ids.add(node.id);
        });
        snapshot.edges.forEach(() => {
          edgeCount++;
        });

        // Compute aggregate retained size per type using dominator-aware
        // aggregation. This deduplicates overlapping retained sizes in the
        // dominator tree so the result reflects how much memory would be freed
        // if all nodes of a given type were garbage-collected together.
        const breakdown: {
          type: string;
          count: number;
          self_size: number;
          retained_size: number;
        }[] = [];

        for (const [type, stats] of typeStats) {
          const retainedSize = utils.aggregateDominatorMetrics(
            stats.node_ids,
            snapshot,
            () => true,
            (node: IHeapNode) => node.retainedSize,
          );
          breakdown.push({
            type,
            count: stats.count,
            self_size: stats.self_size,
            retained_size: retainedSize,
          });
        }

        breakdown.sort((a, b) => b.retained_size - a.retained_size);

        const lines = [
          `**File:** ${getFilePath()}`,
          `**Nodes:** ${formatNumber(nodeCount)} | **Edges:** ${formatNumber(edgeCount)} | **Total Self Size:** ${formatBytes(totalSelfSize)}`,
          '',
        ];

        const headers = ['Type', 'Count', 'Self Size', 'Retained Size'];
        const rightCols = new Set([1, 2, 3]);
        const rows = breakdown.map(b => [
          b.type,
          formatNumber(b.count),
          formatBytes(b.self_size),
          formatBytes(b.retained_size),
        ]);
        lines.push(markdownTable(headers, rows, rightCols));

        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
