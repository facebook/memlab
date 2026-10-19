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
import {nodeRef, pageInfo, structuredResult} from '../structured.js';
import {pageLines, paginate} from '../pagination.js';
import {getSnapshot} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  truncateNodeName,
  errorResult,
} from '../utils.js';

export function registerGetReferrers(server: McpServer): void {
  server.tool(
    'memlab_get_referrers',
    'Get incoming edges (referrers) to a heap node, sorted by source retained size (or `sort_by` self size or name). Shows what objects hold references to this node. Supports edge_filter (match by edge name) and offset (pagination) so a widely-referenced singleton can be explored beyond the first page — e.g. "which referrers are NOT the dev-only Debug alias?". Complements memlab_get_references (outgoing edges). Use memlab_retainer_trace to see the full GC root path.',
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
      sort_by: z
        .enum(['retained_size', 'self_size', 'name'])
        .optional()
        .default('retained_size')
        .describe(
          "Order by the source node's retained size (default), self size, or edge name.",
        ),
      compact: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Truncate source names to 60 chars to save tokens (default true). Set to false to see full names.',
        ),
    },
    async ({node_id, limit, offset, edge_filter, sort_by, compact}) => {
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
        const matched = node.referrers
          .slice()
          .filter(e =>
            filterLc == null
              ? true
              : String(e.name_or_index).toLowerCase().includes(filterLc),
          )
          // Ties by id and edge name, so the same offset pages the same way.
          .sort((a, b) => {
            const byName = () =>
              String(a.name_or_index).localeCompare(String(b.name_or_index));
            const primary =
              sort_by === 'name'
                ? byName()
                : sort_by === 'self_size'
                  ? // `IHeapNode` declares `self_size` (snake case) beside
                    // `retainedSize`; tsc rejects any other spelling here.
                    b.fromNode.self_size - a.fromNode.self_size
                  : b.fromNode.retainedSize - a.fromNode.retainedSize;
            return primary || a.fromNode.id - b.fromNode.id || byName();
          });
        const paged = paginate(matched, offset, limit);
        const edges = paged.items;
        const safeOffset = paged.offset;

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

        // A widely-referenced node often has a long tail of byte-identical
        // referrers (e.g. hundreds of `(sliced string) / parent` edges into one
        // big string). Listing them row by row is pure token cost, so summarise
        // the shape of the whole matched set — including the rows past `limit`.
        const groups = new Map<string, number>();
        for (const e of matched) {
          const k = `${e.fromNode.name} (${e.fromNode.type}) / ${String(e.name_or_index)} / ${e.type}`;
          groups.set(k, (groups.get(k) ?? 0) + 1);
        }
        if (groups.size > 0 && groups.size < matched.length) {
          const summary = [...groups.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([k, n]) => `${formatNumber(n)}× ${k}`)
            .join(' · ');
          lines.push(
            '',
            `_Referrer shapes (all ${formatNumber(matched.length)} matched, not just the rows above): ${summary}${groups.size > 6 ? `, +${formatNumber(groups.size - 6)} more shapes` : ''}._`,
          );
        }

        lines.push('', ...pageLines(paged, 'referrers'));

        return structuredResult(lines.join('\n'), {
          node_id,
          referrers: edges.map(e => ({
            edge: String(e.name_or_index),
            edge_type: e.type,
            node: nodeRef(e.fromNode),
          })),
          pagination: pageInfo(paged),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
