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
  errorResult,
  textResult,
} from '../utils.js';

export function registerFindByProperty(server: McpServer): void {
  server.tool(
    'memlab_find_by_property',
    'Find all objects that have a specific property name (outgoing edge). Useful for identifying objects with React internals (__reactFiber$, __reactProps$), custom data structures, or framework-specific markers. Results sorted by retained size.',
    {
      property_name: z
        .string()
        .describe(
          'The property/edge name to search for (e.g., "__reactFiber$", "cache", "data")',
        ),
      edge_type: z
        .string()
        .optional()
        .describe(
          'Optional edge type filter (property, element, context, internal)',
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of results (default 20)'),
    },
    async ({property_name, edge_type, limit}) => {
      try {
        const snapshot = getSnapshot();

        // Use prefix matching for names ending with $ (React dynamic suffixes)
        const isPrefix = property_name.endsWith('$');

        const results: IHeapNode[] = [];

        snapshot.nodes.forEach(node => {
          if (!isNodeWorthInspecting(node)) return;

          const hasProperty = node.references.some(edge => {
            const edgeName = String(edge.name_or_index);
            const nameMatch = isPrefix
              ? edgeName.startsWith(property_name)
              : edgeName === property_name;
            if (!nameMatch) return false;
            if (edge_type && edge.type !== edge_type) return false;
            return true;
          });

          if (!hasProperty) return;

          // Insertion sort to keep top N by retained size
          const size = node.retainedSize;
          let inserted = false;
          for (let i = 0; i < results.length; i++) {
            if (size > results[i].retainedSize) {
              results.splice(i, 0, node);
              inserted = true;
              break;
            }
          }
          if (!inserted) {
            results.push(node);
          }
          if (results.length > limit) {
            results.length = limit;
          }
        });

        const summaries = results.map(serializeNodeSummary);
        if (summaries.length === 0) {
          return textResult(
            `No objects found with property "${property_name}"${edge_type ? ` (edge type: ${edge_type})` : ''}`,
          );
        }
        return textResult(
          `Found ${summaries.length} objects with property "${property_name}"${edge_type ? ` (edge type: ${edge_type})` : ''}\n\n${formatNodeSummaryTable(summaries)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
