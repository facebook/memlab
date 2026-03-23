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

export function registerGetReferrers(server: McpServer): void {
  server.tool(
    'memlab_get_referrers',
    'Get incoming edges (referrers) to a heap node, sorted by source retained size. Shows what objects hold references to this node.',
    {
      node_id: z.number().describe('The numeric ID of the heap node'),
      limit: z
        .number()
        .optional()
        .default(30)
        .describe('Maximum number of referrers to return (default 30)'),
    },
    async ({node_id, limit}) => {
      try {
        const snapshot = getSnapshot();
        const node = snapshot.getNodeById(node_id);
        if (!node) {
          return errorResult(`Node with id ${node_id} not found`);
        }

        const edges = node.referrers
          .slice()
          .sort((a, b) => b.fromNode.retainedSize - a.fromNode.retainedSize)
          .slice(0, limit);

        const lines = [
          `**@${node_id} ${node.name}** — ${formatNumber(node.numOfReferrers)} total referrers, showing ${edges.length}`,
          '',
        ];

        const headers = [
          'Source ID',
          'Source Name',
          'Source Type',
          'Edge Name',
          'Edge Type',
          'Retained',
        ];
        const rightCols = new Set([5]);
        const rows = edges.map(e => [
          `@${e.fromNode.id}`,
          e.fromNode.name,
          e.fromNode.type,
          String(e.name_or_index),
          e.type,
          formatBytes(e.fromNode.retainedSize),
        ]);
        lines.push(markdownTable(headers, rows, rightCols));

        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
