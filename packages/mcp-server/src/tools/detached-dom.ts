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

function isDetachedDOMNode(node: IHeapNode): boolean {
  if (node.id <= 3) return false;
  if (node.is_detached) return true;
  return node.name.startsWith('Detached ');
}

export function registerDetachedDom(server: McpServer): void {
  server.tool(
    'memlab_detached_dom',
    'Find detached DOM elements still retained in memory. These are common sources of memory leaks — DOM nodes removed from the document but kept alive by JavaScript references. Supports count-only and ids-only modes for large result sets.',
    {
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
    async ({output_mode, offset, limit}) => {
      try {
        const snapshot = getSnapshot();
        const effectiveLimit =
          output_mode === 'ids' ? Math.min(limit, 10000) : Math.min(limit, 500);

        const result = queryNodes(snapshot, isDetachedDOMNode, {
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
