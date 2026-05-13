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
  truncateNodeName,
  formatBytes,
  markdownTable,
  errorResult,
  textResult,
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
    'Find the top N objects by retained size in the loaded heap snapshot. Filters out internal/meta objects. Use node_type to filter to a specific type (e.g., "object", "closure") or exclude_types to remove noisy types (e.g., "string"). Shows a content preview for each node.',
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
    },
    async ({limit, node_type, exclude_types}) => {
      try {
        const snapshot = getSnapshot();

        const excludeSet = exclude_types
          ? new Set(exclude_types.split(',').map(s => s.trim()))
          : null;

        const nodes = filterLargestObjects(
          snapshot,
          (node: IHeapNode) => {
            if (!isNodeWorthInspecting(node)) return false;
            if (node_type && node.type !== node_type) return false;
            if (excludeSet && excludeSet.has(node.type)) return false;
            return true;
          },
          limit,
        );

        const headers = [
          'ID',
          'Name',
          'Type',
          'Self Size',
          'Retained Size',
          'Preview',
        ];
        const rightCols = new Set([3, 4]);
        const rows = nodes.map(n => [
          `@${n.id}`,
          truncateNodeName(n.name, n.type, n.self_size, 60),
          n.type,
          formatBytes(n.self_size),
          formatBytes(n.retainedSize),
          getContentPreview(n),
        ]);

        const filterParts: string[] = [];
        if (node_type) filterParts.push(`type=${node_type}`);
        if (exclude_types) filterParts.push(`excluding ${exclude_types}`);
        const filterNote =
          filterParts.length > 0 ? ` (${filterParts.join(', ')})` : '';
        return textResult(
          `Top ${rows.length} objects by retained size${filterNote}\n\n${markdownTable(headers, rows, rightCols)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
