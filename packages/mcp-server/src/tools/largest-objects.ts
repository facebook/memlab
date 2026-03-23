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
  isNodeWorthInspecting,
  filterLargestObjects,
  serializeNodeSummary,
  formatNodeSummaryTable,
  errorResult,
  textResult,
} from '../utils.js';

export function registerLargestObjects(server: McpServer): void {
  server.tool(
    'memlab_largest_objects',
    'Find the top N objects by retained size in the loaded heap snapshot. Filters out internal/meta objects.',
    {
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of objects to return (default 20)'),
    },
    async ({limit}) => {
      try {
        const snapshot = getSnapshot();
        const nodes = filterLargestObjects(
          snapshot,
          isNodeWorthInspecting,
          limit,
        );
        const summaries = nodes.map(serializeNodeSummary);
        return textResult(
          `Top ${summaries.length} objects by retained size\n\n${formatNodeSummaryTable(summaries)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
