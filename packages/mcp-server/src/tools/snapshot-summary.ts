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
import type {IHeapNode, HeapNodeIdSet} from '@memlab/core';
const {utils, NumericSet} = memlabCore;
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
    'Get an overview of the loaded heap snapshot: total nodes, edges, size, and breakdown by node type with count, self size, and aggregate retained size (dominator-aware, no double-counting). Includes anomaly detection for high-count classes that may indicate leaks. Follow up with memlab_class_histogram for per-class breakdown, or memlab_duplicated_strings to find string duplication.',
    {},
    async () => {
      try {
        const snapshot = getSnapshot();

        let nodeCount = 0;
        let edgeCount = 0;
        let totalSelfSize = 0;
        const typeStats = new Map<
          string,
          {count: number; self_size: number; node_ids: HeapNodeIdSet}
        >();

        snapshot.nodes.forEach(node => {
          nodeCount++;
          totalSelfSize += node.self_size;
          let stats = typeStats.get(node.type);
          if (!stats) {
            stats = {count: 0, self_size: 0, node_ids: new NumericSet()};
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

        // Anomaly detection: find classes with unusually high instance counts
        const classMap = new Map<string, {count: number; type: string}>();
        snapshot.nodes.forEach(node => {
          if (node.id <= 3) return;
          if (node.type === 'hidden' || node.type === 'array') return;
          const key = `${node.type}::${node.name}`;
          const entry = classMap.get(key);
          if (entry) {
            entry.count++;
          } else {
            classMap.set(key, {count: 1, type: node.type});
          }
        });

        const anomalies = [...classMap.entries()]
          .filter(([, v]) => v.count >= 5000)
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 5);

        if (anomalies.length > 0) {
          lines.push('');
          lines.push(
            '**Potential anomalies** (classes with ≥5,000 instances):',
          );
          for (const [key, v] of anomalies) {
            const name = key.split('::').slice(1).join('::');
            lines.push(`- ${formatNumber(v.count)}× \`${name}\` (${v.type})`);
          }
          // Check for correlated high-count groups
          const highCountNames = anomalies.map(([key]) =>
            key.split('::').slice(1).join('::'),
          );
          if (highCountNames.length >= 2) {
            const counts = anomalies.map(([, v]) => v.count);
            const maxCount = Math.max(...counts);
            const minCount = Math.min(...counts);
            if (minCount >= maxCount * 0.8) {
              lines.push(
                `- Similar counts suggest these may share a common root cause`,
              );
            }
          }
          lines.push(
            '',
            'Use `memlab_class_histogram` for the full breakdown, or `memlab_retainer_summary` on a class above to investigate retention patterns.',
          );
        }

        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
