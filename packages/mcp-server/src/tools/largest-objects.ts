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
  isNodeWorthInspecting,
  filterLargestObjects,
  collapseDominatorSubtrees,
  truncateNodeName,
  formatBytes,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';

function sanitizeForTable(s: string): string {
  return s.replace(/[\n\r\t]/g, ' ').replace(/\|/g, '¦');
}

function getContentPreview(node: IHeapNode): string {
  if (node.isString) {
    const strNode = node.toStringNode();
    if (strNode) {
      const val = strNode.stringValue;
      const preview = val.length > 60 ? val.slice(0, 60) + '…' : val;
      return sanitizeForTable(preview);
    }
  }
  // For objects/arrays, show first few property names
  const props: string[] = [];
  for (const edge of node.references) {
    if (
      edge.type === 'property' ||
      edge.type === 'element' ||
      edge.type === 'shortcut'
    ) {
      props.push(String(edge.name_or_index));
      if (props.length >= 4) break;
    }
  }
  if (props.length > 0) {
    const more = node.edge_count > props.length ? ', …' : '';
    return `{${props.join(', ')}${more}}`;
  }
  return '';
}

export function registerLargestObjects(server: McpServer): void {
  server.tool(
    'memlab_largest_objects',
    'Find the top N objects by retained size in the loaded heap snapshot. Filters out internal/meta objects. Use node_type to filter to a specific type (e.g., "object", "closure") or exclude_types to remove noisy types (e.g., "string"). Shows a content preview for each node. By default it collapses multiple views of the SAME dominator subtree (e.g. Client → Request → … → Map all at one retained size on a single in-flight request) into one representative row so the list is not dominated by ~20 duplicate rows; pass collapse_subtrees:false to see every node.',
    {
      limit: z
        .number()
        .optional()
        .default(25)
        .describe('Maximum number of objects to return (default 25)'),
      node_type: z
        .string()
        .optional()
        .describe(
          'Only include this node type (e.g., "object", "closure", "string", "regexp").',
        ),
      exclude_types: z
        .string()
        .optional()
        .describe(
          'Comma-separated node types to exclude (e.g., "string,concatenated string"). Useful to filter out large strings dominating the list.',
        ),
      collapse_subtrees: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Collapse nodes that are different views of the same dominator subtree (same retained size + one dominates the other) into a single representative row, annotated with how many views were folded in (default true). Set false to see every node, including all internal nodes of one big subtree.',
        ),
    },
    async ({limit, node_type, exclude_types, collapse_subtrees}) => {
      try {
        const snapshot = getSnapshot();

        const excludeSet = exclude_types
          ? new Set(exclude_types.split(',').map(s => s.trim()))
          : null;

        // When collapsing, over-fetch candidates so a single big subtree's many
        // same-retained-size views don't crowd out distinct subtrees before
        // dedup. Bounded so the retained-size sort stays cheap on huge heaps.
        const fetchLimit = collapse_subtrees
          ? Math.min(Math.max(limit * 6, limit + 30), 300)
          : limit;

        const candidates = filterLargestObjects(
          snapshot,
          (node: IHeapNode) => {
            if (!isNodeWorthInspecting(node)) return false;
            if (node_type && node.type !== node_type) return false;
            if (excludeSet && excludeSet.has(node.type)) return false;
            return true;
          },
          fetchLimit,
        );

        const groups = collapse_subtrees
          ? collapseDominatorSubtrees(candidates, limit)
          : candidates.slice(0, limit).map(node => ({node, mergedCount: 0}));

        const headers = [
          'ID',
          'Name',
          'Type',
          'Self Size',
          'Retained Size',
          'Preview',
        ];
        const rightCols = new Set([3, 4]);
        const rows = groups.map(({node: n, mergedCount}) => {
          const mergeNote =
            mergedCount > 0
              ? `(+${mergedCount} more view${mergedCount > 1 ? 's' : ''} of this subtree) `
              : '';
          return [
            `@${n.id}`,
            truncateNodeName(n.name, n.type, n.self_size, 60),
            n.type,
            formatBytes(n.self_size),
            formatBytes(n.retainedSize),
            mergeNote + getContentPreview(n),
          ];
        });

        const filterParts: string[] = [];
        if (node_type) filterParts.push(`type=${node_type}`);
        if (exclude_types) filterParts.push(`excluding ${exclude_types}`);
        const filterNote =
          filterParts.length > 0 ? ` (${filterParts.join(', ')})` : '';
        const collapsed = groups.reduce((s, g) => s + g.mergedCount, 0);
        const collapseNote =
          collapse_subtrees && collapsed > 0
            ? `\n_Collapsed ${collapsed} same-subtree view(s) into their representative rows; pass collapse_subtrees:false to see every node._`
            : '';
        return toolResult(
          `Top ${rows.length} objects by retained size${filterNote}\n\n${markdownTable(headers, rows, rightCols)}${collapseNote}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
