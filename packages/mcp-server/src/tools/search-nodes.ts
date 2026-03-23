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
import type {IHeapNode} from '@memlab/core';
import {
  queryNodes,
  formatQueryNodesResult,
  errorResult,
  textResult,
} from '../utils.js';
import type {OutputMode} from '../utils.js';

export function registerSearchNodes(server: McpServer): void {
  server.tool(
    'memlab_search_nodes',
    'General-purpose search for heap nodes by combining filters: name pattern (regex), node type, minimum retained/self size, and detachment status. Results sorted by retained size. Supports count-only and ids-only modes for large result sets.',
    {
      name_pattern: z
        .string()
        .optional()
        .describe('Regex pattern to match against node names'),
      type: z
        .string()
        .optional()
        .describe(
          'Node type filter (e.g. object, string, closure, regexp, number, array, hidden, native, code, synthetic)',
        ),
      min_retained_size: z
        .number()
        .optional()
        .describe('Minimum retained size in bytes'),
      min_self_size: z
        .number()
        .optional()
        .describe('Minimum self (shallow) size in bytes'),
      is_detached: z
        .boolean()
        .optional()
        .describe('Filter by detachment status'),
      output_mode: z
        .enum(['full', 'count', 'ids'])
        .optional()
        .default('full')
        .describe(
          'Output verbosity: "full" returns node summaries (default), "count" returns only the total count, "ids" returns only node IDs',
        ),
      offset: z
        .number()
        .optional()
        .default(0)
        .describe('Skip the first N results (for pagination)'),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe(
          'Maximum number of results (default 20, up to 10000 for ids mode)',
        ),
    },
    async ({
      name_pattern,
      type,
      min_retained_size,
      min_self_size,
      is_detached,
      output_mode,
      offset,
      limit,
    }) => {
      try {
        const snapshot = getSnapshot();
        const nameRegex = name_pattern ? new RegExp(name_pattern, 'i') : null;
        const effectiveLimit =
          output_mode === 'ids' ? Math.min(limit, 10000) : Math.min(limit, 500);

        const filter = (node: IHeapNode) => {
          if (node.id <= 3) return false;
          if (type && node.type !== type) return false;
          if (nameRegex && !nameRegex.test(node.name)) return false;
          if (min_retained_size && node.retainedSize < min_retained_size)
            return false;
          if (min_self_size && node.self_size < min_self_size) return false;
          if (is_detached !== undefined) {
            const detached =
              node.is_detached || node.name.startsWith('Detached ');
            if (is_detached !== detached) return false;
          }
          return true;
        };

        const result = queryNodes(snapshot, filter, {
          limit: effectiveLimit,
          offset,
          outputMode: output_mode as OutputMode,
        });

        return textResult(formatQueryNodesResult(result, offset));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
