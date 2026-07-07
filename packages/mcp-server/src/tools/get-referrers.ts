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
  truncateNodeName,
  errorResult,
  toolResult,
} from '../utils.js';

export function registerGetReferrers(server: McpServer): void {
  server.tool(
    'memlab_get_referrers',
    'Get incoming edges (referrers) to a heap node, sorted by source retained size. Shows what objects hold references to this node. Supports edge_filter (match by edge name) and offset (pagination) so a widely-referenced singleton can be explored beyond the first page — e.g. "which referrers are NOT the dev-only Debug alias?". Complements memlab_get_references (outgoing edges). Use memlab_retainer_trace to see the full GC root path.',
    {
      node_id: z.number().describe('The numeric ID of the heap node'),
      limit: z
        .number()
        .optional()
        .default(30)
        .describe('Maximum number of referrers to return (default 30)'),
      offset: z
        .number()
        .optional()
        .default(0)
        .describe(
          'Number of (filtered, sorted) referrers to skip before returning — for paging past the first `limit` on widely-referenced nodes (default 0).',
        ),
      edge_filter: z
        .string()
        .optional()
        .describe(
          'Case-insensitive substring; only referrers whose edge name/index contains it are returned. Applied before sort + pagination, so you can isolate one referrer among hundreds instead of scanning the top-N.',
        ),
      compact: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Truncate source names to 60 chars to save tokens (default true). Set to false to see full names.',
        ),
    },
    async ({node_id, limit, offset, edge_filter, compact}) => {
      try {
        const snapshot = getSnapshot();
        const node = snapshot.getNodeById(node_id);
        if (!node) {
          return errorResult(`Node with id ${node_id} not found`);
        }

        // Treat an empty / whitespace-only filter as "no filter" so the header
        // doesn't advertise a filter that matches every referrer, and clamp a
        // negative offset to 0 rather than letting slice() read from the tail.
        const activeFilter =
          edge_filter != null && edge_filter.trim() !== '' ? edge_filter : null;
        const filterLc = activeFilter?.toLowerCase();
        const safeOffset = Math.max(0, offset);
        const matched = node.referrers
          .slice()
          .filter(e =>
            filterLc == null
              ? true
              : String(e.name_or_index).toLowerCase().includes(filterLc),
          )
          .sort((a, b) => b.fromNode.retainedSize - a.fromNode.retainedSize);
        const edges = matched.slice(safeOffset, safeOffset + limit);

        const filterNote =
          activeFilter != null
            ? `, ${formatNumber(matched.length)} match "${activeFilter}"`
            : '';
        const offsetNote = safeOffset > 0 ? ` (from offset ${safeOffset})` : '';
        const lines = [
          `**@${node_id} ${node.name}** — ${formatNumber(node.numOfReferrers)} total referrers${filterNote}, showing ${edges.length}${offsetNote}`,
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
        const nameMaxLen = compact ? 60 : 300;
        const rows = edges.map(e => [
          `@${e.fromNode.id}`,
          truncateNodeName(
            e.fromNode.name,
            e.fromNode.type,
            e.fromNode.self_size,
            nameMaxLen,
          ),
          e.fromNode.type,
          String(e.name_or_index),
          e.type,
          formatBytes(e.fromNode.retainedSize),
        ]);
        lines.push(markdownTable(headers, rows, rightCols));

        const shownEnd = safeOffset + edges.length;
        if (shownEnd < matched.length) {
          lines.push(
            '',
            `_${formatNumber(matched.length - shownEnd)} more — pass offset=${shownEnd} for the next page._`,
          );
        } else if (edges.length === 0 && safeOffset > 0 && matched.length > 0) {
          lines.push(
            '',
            `_offset ${safeOffset} is past the last of ${formatNumber(matched.length)} matched referrers — use a smaller offset._`,
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
