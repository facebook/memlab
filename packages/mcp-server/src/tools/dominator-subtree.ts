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
import type {IHeapNode} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  serializeNodeSummary,
  isNodeWorthInspecting,
  formatNodeSummaryTable,
  formatNodeInline,
  errorResult,
  textResult,
  formatBytes,
  formatNumber,
} from '../utils.js';

export function registerDominatorSubtree(server: McpServer): void {
  server.tool(
    'memlab_dominator_subtree',
    'Show the direct children in the dominator tree for a given node — i.e., objects whose retained size is exclusively attributed to this node. These are the objects that would be freed if this node were garbage collected. Useful for understanding what composes a large retained size.',
    {
      node_id: z.number().describe('The numeric ID of the heap node'),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe(
          'Maximum number of dominated children to return (default 20)',
        ),
      include_internal: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include internal/meta nodes (default false)'),
    },
    async ({node_id, limit, include_internal}) => {
      try {
        const snapshot = getSnapshot();
        const targetNode = snapshot.getNodeById(node_id);
        if (!targetNode) {
          return errorResult(`Node with id ${node_id} not found`);
        }

        // Find all nodes directly dominated by this node
        const dominated: IHeapNode[] = [];
        let totalDominated = 0;

        snapshot.nodes.forEach(node => {
          if (node.dominatorNode?.id === node_id && node.id !== node_id) {
            totalDominated++;
            if (!include_internal && !isNodeWorthInspecting(node)) return;

            // Insertion sort to keep top N by retained size
            const size = node.retainedSize;
            let inserted = false;
            for (let i = 0; i < dominated.length; i++) {
              if (size > dominated[i].retainedSize) {
                dominated.splice(i, 0, node);
                inserted = true;
                break;
              }
            }
            if (!inserted) {
              dominated.push(node);
            }
            if (dominated.length > limit) {
              dominated.length = limit;
            }
          }
        });

        const summaries = dominated.map(serializeNodeSummary);
        const lines = [
          `**${formatNodeInline(targetNode.id, targetNode.name, targetNode.type)}** — retained ${formatBytes(targetNode.retainedSize)}, ${formatNumber(totalDominated)} dominated nodes (showing ${summaries.length})`,
          '',
        ];
        if (summaries.length > 0) {
          lines.push(formatNodeSummaryTable(summaries));
        } else {
          lines.push('No dominated nodes found.');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
