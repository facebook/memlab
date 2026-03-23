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
} from '../utils.js';

export function registerObjectShape(server: McpServer): void {
  server.tool(
    'memlab_object_shape',
    'Show the shape/structure of a heap object: all its named properties with target node types and sizes. Filters out internal/hidden edges to show only user-visible properties. Use this to understand what an object contains at a glance.',
    {
      node_id: z.number().describe('The numeric ID of the heap node'),
      include_internal: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include internal/hidden edges (default false)'),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe('Maximum number of properties to return (default 50)'),
    },
    async ({node_id, include_internal, limit}) => {
      try {
        const snapshot = getSnapshot();
        const node = snapshot.getNodeById(node_id);
        if (!node) {
          return errorResult(`Node with id ${node_id} not found`);
        }

        const userEdgeTypes = new Set([
          'property',
          'element',
          'context',
          'shortcut',
        ]);

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
          `**${formatNodeInline(node.id, node.name, node.type)}** — ${formatNumber(totalEdges)} edges total${hiddenCount > 0 ? `, ${formatNumber(hiddenCount)} internal hidden` : ''}`,
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

        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
