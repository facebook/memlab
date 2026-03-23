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
  markdownTable,
  errorResult,
  textResult,
} from '../utils.js';

export function registerGetReferences(server: McpServer): void {
  server.tool(
    'memlab_get_references',
    'Get outgoing edges (references) from a heap node, sorted by target retained size. Shows what objects this node points to.',
    {
      node_id: z.number().describe('The numeric ID of the heap node'),
      limit: z
        .number()
        .optional()
        .default(30)
        .describe('Maximum number of references to return (default 30)'),
    },
    async ({node_id, limit}) => {
      try {
        const snapshot = getSnapshot();
        const node = snapshot.getNodeById(node_id);
        if (!node) {
          return errorResult(`Node with id ${node_id} not found`);
        }

        const edges = node.references
          .slice()
          .sort((a, b) => b.toNode.retainedSize - a.toNode.retainedSize)
          .slice(0, limit);

        const lines = [
          `**@${node_id} ${node.name}** — ${formatNumber(node.edge_count)} total references, showing ${edges.length}`,
          '',
        ];

        const headers = [
          'Edge Name',
          'Edge Type',
          'Target ID',
          'Target Name',
          'Target Type',
          'Retained',
        ];
        const rightCols = new Set([5]);
        const rows = edges.map(e => [
          String(e.name_or_index),
          e.type,
          `@${e.toNode.id}`,
          e.toNode.name,
          e.toNode.type,
          formatBytes(e.toNode.retainedSize),
        ]);
        lines.push(markdownTable(headers, rows, rightCols));

        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
