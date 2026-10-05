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
import {sourceOfNode} from './module-attribution.js';
import {errorResult, markdownTable, toolResult} from '../utils.js';

export function registerSourceForNode(server: McpServer): void {
  server.tool(
    'memlab_source_for_node',
    'Which MODULE\'s code a node belongs to — the step from "which object" to "which file" without a code-search round trip. A closure is resolved through its context chain to the module scope its Haste factory created (exact, via ScopeInfo); any other node is first walked up its retainer path to the nearest closure or context. Also returns the bundle script URL and, when the snapshot has one, the source location (usually absent on bundled builds, which is why the module is read structurally).',
    {
      node_ids: z
        .array(z.number())
        .min(1)
        .describe('Node ids to resolve (closures, contexts, or any object).'),
      max_hops: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .default(40)
        .describe(
          'Retainer hops to walk up from a non-code node (default 40).',
        ),
    },
    async ({node_ids, max_hops}) => {
      try {
        const snapshot = getSnapshot();
        const rows = node_ids.map(id => {
          const node = snapshot.getNodeById(id);
          if (node == null) return [`@${id}`, '(not found)', '—', '—', '—'];
          let src: ReturnType<typeof sourceOfNode>;
          try {
            src = sourceOfNode(snapshot, node, max_hops);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return [
              `@${id} ${node.name.slice(0, 40)}`,
              `(error: ${msg.slice(0, 80)})`,
              '—',
              '—',
              '—',
            ];
          }
          return [
            `@${id} ${node.name.slice(0, 40)}`,
            src.module ?? '(no module found)',
            src.via != null
              ? `${src.via.name.slice(0, 40)} @${src.via.id}${src.hops > 0 ? ` (${src.hops} hop(s) up)` : ''}`
              : '—',
            src.location != null
              ? `${src.location.line}:${src.location.column}`
              : '—',
            src.script != null
              ? src.script.replace(/\?.*$/, '').slice(-60)
              : '—',
          ];
        });
        return toolResult(
          [
            '## Source module per node',
            '',
            markdownTable(
              ['Node', 'Module', 'Read from', 'Line:col', 'Script'],
              rows,
            ),
            '',
            '_`Read from` is the closure or context whose scope chain named the module. A closure defined at a bundle\'s top level, outside any module factory, has no module scope and reads "(no module found)"._',
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
