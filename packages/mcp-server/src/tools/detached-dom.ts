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
import {getSnapshot, getSnapshotEnv} from '../heap-state.js';
import type {IHeapNode} from '@memlab/core';
import {
  queryNodes,
  formatQueryNodesResult,
  errorResult,
  textResult,
  toolResult,
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
        const env = getSnapshotEnv();
        if (env === 'node') {
          return toolResult(
            'This is a Node.js snapshot — DOM nodes do not exist in this environment.\n\n' +
              'For Node.js memory investigation, try instead:\n' +
              '- `memlab_duplicated_strings` — find duplicated string instances\n' +
              '- `memlab_closure_inspection` — inspect closure captured variables\n' +
              '- `memlab_largest_objects` — find objects consuming the most memory\n' +
              '- `memlab_class_histogram` — per-class instance counts and sizes',
          );
        }
        const snapshot = getSnapshot();
        const effectiveLimit =
          output_mode === 'ids' ? Math.min(limit, 10000) : Math.min(limit, 500);

        const result = queryNodes(snapshot, isDetachedDOMNode, {
          limit: effectiveLimit,
          offset,
          outputMode: output_mode as OutputMode,
        });

        const output = formatQueryNodesResult(result, offset);
        if (result.total_count > 0 && output_mode === 'full') {
          return toolResult(
            output +
              '\n\n---\n\n' +
              '**Suggested action:** Check for missing `removeEventListener` calls, ' +
              'React component cleanup in `useEffect` return, or refs not cleared on unmount. ' +
              'Use `memlab_retainer_trace` on top entries to find the retention path.',
          );
        }
        return toolResult(output);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
