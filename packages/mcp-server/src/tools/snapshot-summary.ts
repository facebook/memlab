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
import {z} from 'zod';
import {getSnapshot, getFilePath} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  detectAppName,
  errorResult,
  toolResult,
} from '../utils.js';

export function registerSnapshotSummary(server: McpServer): void {
  server.tool(
    'memlab_snapshot_summary',
    'Get an overview of the loaded heap snapshot: total nodes, edges, size, and per-node-type breakdown with count and self size. ' +
      'By DEFAULT retained size per type is reported as a cheap RANGE (lower bound = Σ self size, upper bound = Σ retained size) computed in a single O(N) pass — the exact dominator-deduped retained size needs a per-type dominator walk that can stall/OOM the server on very large heaps. Pass `exact_retained_size:true` ONLY when the user explicitly asks for the exact figure. ' +
      'Includes anomaly detection for high-count classes. Follow up with memlab_class_histogram for a per-class breakdown, or memlab_duplicated_strings to find string duplication.',
    {
      exact_retained_size: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Compute the EXACT dominator-deduped retained size per node type via aggregateDominatorMetrics. DEFAULT false: report a range instead (lower = Σ self size, upper = Σ raw retained size), which is fast and safe on huge heaps. Set true ONLY on explicit user request — the exact walk can be very slow or time out on snapshots with millions of nodes and deep dominator chains.',
        ),
    },
    async ({exact_retained_size}) => {
      try {
        const snapshot = getSnapshot();

        let nodeCount = 0;
        let edgeCount = 0;
        let totalSelfSize = 0;
        const typeStats = new Map<
          string,
          {
            count: number;
            self_size: number;
            raw_retained: number;
            node_ids: HeapNodeIdSet | null;
          }
        >();

        snapshot.nodes.forEach(node => {
          nodeCount++;
          totalSelfSize += node.self_size;
          let stats = typeStats.get(node.type);
          if (!stats) {
            stats = {
              count: 0,
              self_size: 0,
              raw_retained: 0,
              // Only collect per-node ids for the exact dominator walk, which
              // is opt-in — in the default range mode they would waste memory.
              node_ids: exact_retained_size ? new NumericSet() : null,
            };
            typeStats.set(node.type, stats);
          }
          stats.count++;
          stats.self_size += node.self_size;
          stats.raw_retained += node.retainedSize;
          if (stats.node_ids) stats.node_ids.add(node.id);
        });
        snapshot.edges.forEach(() => {
          edgeCount++;
        });

        // Retained size per type. By DEFAULT we do NOT run the exact
        // dominator-aware aggregation (utils.aggregateDominatorMetrics): on
        // large heaps with deep dominator chains it is the operation that
        // stalls/OOMs the server. Instead we report a cheap range computed in
        // the O(N) pass above:
        //   - lower bound = Σ self size (the objects' own bytes; never
        //     double-counts, but excludes everything they retain)
        //   - upper bound = Σ retained size (raw; double-counts memory shared
        //     between instances on the dominator tree)
        // The true dominator-deduped value lies in [lower, upper]. Pass
        // exact_retained_size:true to compute the exact figure anyway.
        const breakdown: {
          type: string;
          count: number;
          self_size: number;
          raw_retained: number;
          exact: number | null;
        }[] = [];

        for (const [type, stats] of typeStats) {
          let exact: number | null = null;
          if (exact_retained_size && stats.node_ids) {
            exact = utils.aggregateDominatorMetrics(
              stats.node_ids,
              snapshot,
              () => true,
              (node: IHeapNode) => node.retainedSize,
            );
          }
          breakdown.push({
            type,
            count: stats.count,
            self_size: stats.self_size,
            raw_retained: stats.raw_retained,
            exact,
          });
        }

        breakdown.sort((a, b) =>
          exact_retained_size
            ? (b.exact ?? 0) - (a.exact ?? 0)
            : b.raw_retained - a.raw_retained,
        );

        const appName = detectAppName(snapshot);
        const lines = [
          `**File:** ${getFilePath()}`,
          ...(appName
            ? [`**Detected app:** \`${appName}\` (from bundle paths)`]
            : []),
          `**Nodes:** ${formatNumber(nodeCount)} | **Edges:** ${formatNumber(edgeCount)} | **Total Self Size:** ${formatBytes(totalSelfSize)}`,
          '',
        ];

        const headers = exact_retained_size
          ? ['Type', 'Count', 'Self Size', 'Retained Size']
          : ['Type', 'Count', 'Self (lower)', 'Retained ≤ (upper)'];
        const rightCols = new Set([1, 2, 3]);
        const rows = breakdown.map(b => [
          b.type,
          formatNumber(b.count),
          formatBytes(b.self_size),
          exact_retained_size
            ? formatBytes(b.exact ?? 0)
            : `≤ ${formatBytes(b.raw_retained)}`,
        ]);
        lines.push(markdownTable(headers, rows, rightCols));
        if (!exact_retained_size) {
          lines.push(
            '',
            "_Retained size is shown as a **range** to avoid an expensive dominator walk. The true dominator-deduped retained size of each type lies between the **lower bound** (`Self` = the objects' own bytes) and the **upper bound** (`Retained ≤` = Σ of each instance's retained size, which double-counts memory shared between instances on the dominator tree). Computing the exact value needs a per-type dominator walk — slow and, on large heaps with deep PromiseReaction/Context chains, prone to stalling or timing out. Pass `exact_retained_size:true` to compute it anyway._",
          );
        }

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

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
