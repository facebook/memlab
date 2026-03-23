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
  serializeNodeDetail,
  formatBytes,
  formatNumber,
  errorResult,
  textResult,
} from '../utils.js';

export function registerGetNode(server: McpServer): void {
  server.tool(
    'memlab_get_node',
    'Look up a heap node by its numeric ID. Returns full details including size, type, detachment status, dominator, location, and string value if applicable.',
    {
      node_id: z.number().describe('The numeric ID of the heap node'),
    },
    async ({node_id}) => {
      try {
        const snapshot = getSnapshot();
        const node = snapshot.getNodeById(node_id);
        if (!node) {
          return errorResult(`Node with id ${node_id} not found`);
        }
        const d = serializeNodeDetail(node);
        const lines = [
          `**ID:** @${d.id}`,
          `**Name:** ${d.name}`,
          `**Type:** ${d.type}`,
          `**Self Size:** ${formatBytes(d.self_size)}`,
          `**Retained Size:** ${formatBytes(d.retained_size)}`,
          `**Edges Out:** ${formatNumber(d.edge_count)}`,
          `**Referrers:** ${formatNumber(d.referrer_count)}`,
          `**Detached:** ${d.is_detached ? 'Yes' : 'No'}`,
          `**Dominator:** ${d.dominator_id != null ? `@${d.dominator_id}` : 'none'}`,
        ];
        if (d.location) {
          lines.push(
            `**Location:** script ${d.location.script_id}, line ${d.location.line}, col ${d.location.column}`,
          );
        }
        if (d.string_value !== undefined) {
          const val =
            d.string_value.length > 200
              ? d.string_value.slice(0, 200) + '...'
              : d.string_value;
          lines.push(`**String Value:** "${val}"`);
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
