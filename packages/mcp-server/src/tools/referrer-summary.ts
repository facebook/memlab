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
import {getSnapshot} from '../heap-state.js';
import {
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';

interface ReferrerGroup {
  edgeName: string;
  sourceClass: string;
  count: number;
  totalRetainedSize: number;
  sampleIds: number[];
}

export function registerReferrerSummary(server: McpServer): void {
  server.tool(
    'memlab_referrer_summary',
    'Group all incoming references (referrers) of a node by edge name and source class. ' +
      'Answers "how many things reference this node, and via which edge names?" — ' +
      'essential for understanding why an object is retained and whether a single ' +
      'edge name dominates. Saves multiple eval round trips when investigating ' +
      'event listener accumulation, cache retention, or shared object references.',
    {
      node_id: z.number().describe('The node ID to analyze referrers for'),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of referrer groups to return (default 20)'),
      min_count: z
        .number()
        .optional()
        .default(1)
        .describe(
          'Minimum number of referrers in a group to include (default 1)',
        ),
      sample_ids: z
        .number()
        .optional()
        .default(3)
        .describe(
          'Number of sample source node IDs to include per group (default 3)',
        ),
    },
    async ({node_id, limit, min_count, sample_ids}) => {
      try {
        const snapshot = getSnapshot();
        const node = snapshot.getNodeById(node_id);
        if (!node) {
          return errorResult(new Error(`Node @${node_id} not found`));
        }

        const groups = new Map<string, ReferrerGroup>();
        let totalReferrers = 0;

        for (const edge of node.referrers) {
          totalReferrers++;
          const edgeName = String(edge.name_or_index);
          const sourceClass = edge.fromNode.name;
          const key = `${edgeName}\0${sourceClass}`;

          const existing = groups.get(key);
          if (existing) {
            existing.count++;
            existing.totalRetainedSize += edge.fromNode.retainedSize;
            if (existing.sampleIds.length < sample_ids) {
              existing.sampleIds.push(edge.fromNode.id);
            }
          } else {
            groups.set(key, {
              edgeName,
              sourceClass,
              count: 1,
              totalRetainedSize: edge.fromNode.retainedSize,
              sampleIds: [edge.fromNode.id],
            });
          }
        }

        const sorted = [...groups.values()]
          .filter(g => g.count >= min_count)
          .sort((a, b) => b.count - a.count)
          .slice(0, limit);

        if (sorted.length === 0) {
          return toolResult(
            `@${node_id} \`${node.name}\` (${node.type}) has ${totalReferrers} referrer(s), none matching min_count >= ${min_count}.`,
          );
        }

        const lines = [
          `Referrer summary for @${node_id} \`${node.name}\` (${node.type}): **${formatNumber(totalReferrers)} total referrers** in ${formatNumber(groups.size)} groups`,
          '',
        ];

        const headers = [
          'Edge Name',
          'Source Class',
          'Count',
          '% of Total',
          'Sample IDs',
        ];
        const rightCols = new Set([2, 3]);
        const rows = sorted.map(g => {
          const pct =
            totalReferrers > 0
              ? ((g.count / totalReferrers) * 100).toFixed(1) + '%'
              : '-';
          return [
            g.edgeName,
            g.sourceClass,
            formatNumber(g.count),
            pct,
            g.sampleIds.map(id => `@${id}`).join(', '),
          ];
        });

        lines.push(markdownTable(headers, rows, rightCols));

        if (sorted.length < groups.size) {
          lines.push(
            '',
            `Showing top ${sorted.length} of ${formatNumber(groups.size)} groups.`,
          );
        }

        const topGroup = sorted[0];
        if (topGroup.count > totalReferrers * 0.5 && totalReferrers > 10) {
          lines.push(
            '',
            `**Dominant pattern:** ${formatNumber(topGroup.count)} of ${formatNumber(totalReferrers)} referrers (${((topGroup.count / totalReferrers) * 100).toFixed(0)}%) come via \`.${topGroup.edgeName}\` on \`${topGroup.sourceClass}\` instances.`,
          );
        }

        lines.push('', '**Suggested next steps:**');
        lines.push(
          `- Inspect top referrer: \`memlab_get_node(${topGroup.sampleIds[0]})\``,
        );
        lines.push(
          `- Trace retention: \`memlab_retainer_trace(${topGroup.sampleIds[0]})\``,
        );
        if (topGroup.count > 100) {
          lines.push(
            `- Check accumulation: \`memlab_retainer_summary\` with node_ids from samples`,
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
