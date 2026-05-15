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
  formatBytes,
  formatNumber,
  formatNodeInline,
  markdownTable,
  errorResult,
  textResult,
  toolResult,
} from '../utils.js';

export function registerObjectShape(server: McpServer): void {
  server.tool(
    'memlab_object_shape',
    'Show the shape/structure of one or more heap objects: all named properties with target node types and sizes. Filters out internal/hidden edges to show only user-visible properties. Supports batch inspection via node_ids to compare multiple objects side-by-side in a single call.',
    {
      node_id: z
        .number()
        .optional()
        .describe(
          'The numeric ID of a single heap node. Use node_ids for batch inspection.',
        ),
      node_ids: z
        .array(z.number())
        .optional()
        .describe(
          'Array of node IDs to inspect in a single call (batch mode). Returns shape for each node.',
        ),
      include_internal: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include internal/hidden edges (default false)'),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe(
          'Maximum number of properties to return per node (default 50)',
        ),
    },
    async ({node_id, node_ids, include_internal, limit}) => {
      try {
        const snapshot = getSnapshot();

        const ids: number[] = node_ids ?? (node_id != null ? [node_id] : []);
        if (ids.length === 0) {
          return errorResult('Provide either node_id or node_ids to inspect.');
        }
        if (ids.length > 20) {
          return errorResult(
            'Maximum 20 nodes per batch. Reduce node_ids count.',
          );
        }

        const userEdgeTypes = new Set([
          'property',
          'element',
          'context',
          'shortcut',
        ]);

        const sections: string[] = [];
        for (const id of ids) {
          const node = snapshot.getNodeById(id);
          if (!node) {
            sections.push(`**@${id}** — not found\n`);
            continue;
          }

          const filteredEdges = node.references
            .filter(edge => include_internal || userEdgeTypes.has(edge.type))
            .sort((a, b) => b.toNode.retainedSize - a.toNode.retainedSize)
            .slice(0, limit);

          const totalEdges = node.references.length;
          const hiddenCount = include_internal
            ? 0
            : totalEdges -
              node.references.filter(e => userEdgeTypes.has(e.type)).length;

          const lines = [
            `**${formatNodeInline(node.id, node.name, node.type, node.self_size)}** — ${formatNumber(totalEdges)} edges total${hiddenCount > 0 ? `, ${formatNumber(hiddenCount)} internal hidden` : ''}`,
            '',
          ];

          const headers = [
            'Name',
            'Edge Type',
            'Target',
            'Target Type',
            'Retained',
          ];
          const rightCols = new Set([4]);
          const rows = filteredEdges.map(edge => {
            const target = edge.toNode;
            let targetLabel = `@${target.id} ${target.name}`;
            if (target.isString) {
              const strNode = target.toStringNode();
              if (strNode) {
                const val = strNode.stringValue;
                targetLabel = `@${target.id} "${val.length > 60 ? val.slice(0, 60) + '...' : val}"`;
              }
            }
            return [
              String(edge.name_or_index),
              edge.type,
              targetLabel,
              target.type,
              formatBytes(target.retainedSize),
            ];
          });
          lines.push(markdownTable(headers, rows, rightCols));
          sections.push(lines.join('\n'));
        }

        return toolResult(sections.join('\n\n---\n\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
