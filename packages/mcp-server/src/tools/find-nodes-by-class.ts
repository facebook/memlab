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
  filterLargestObjects,
  serializeNodeSummary,
  formatNodeSummaryTable,
  errorResult,
  textResult,
} from '../utils.js';

export function registerFindNodesByClass(server: McpServer): void {
  server.tool(
    'memlab_find_nodes_by_class',
    'Find heap objects by constructor/class name. Returns matching objects sorted by retained size.',
    {
      class_name: z
        .string()
        .describe('The constructor or class name to search for'),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of results (default 20)'),
    },
    async ({class_name, limit}) => {
      try {
        const snapshot = getSnapshot();
        const nodes = filterLargestObjects(
          snapshot,
          node => node.name === class_name && node.type === 'object',
          limit,
        );
        const summaries = nodes.map(serializeNodeSummary);
        if (summaries.length === 0) {
          return textResult(`No objects found with class "${class_name}"`);
        }
        return textResult(
          `Found ${summaries.length} "${class_name}" objects\n\n${formatNodeSummaryTable(summaries)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
