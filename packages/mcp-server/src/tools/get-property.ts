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
import type {NodeDetail} from '../utils.js';

export function registerGetProperty(server: McpServer): void {
  server.tool(
    'memlab_get_property',
    'Look up a specific property (outgoing edge) of a heap node by name and return the target node with full details. Useful for traversing the object graph step by step (e.g., get the __proto__, stateNode, or memoizedState of a node).',
    {
      node_id: z.number().describe('The numeric ID of the heap node'),
      property_name: z
        .string()
        .describe(
          'The property/edge name to look up (e.g., "__proto__", "stateNode", "0")',
        ),
      edge_type: z
        .string()
        .optional()
        .describe(
          'Optional edge type filter (property, element, context, internal, hidden, shortcut, weak)',
        ),
    },
    async ({node_id, property_name, edge_type}) => {
      try {
        const snapshot = getSnapshot();
        const node = snapshot.getNodeById(node_id);
        if (!node) {
          return errorResult(`Node with id ${node_id} not found`);
        }

        const matching = node.references.filter(edge => {
          if (String(edge.name_or_index) !== property_name) return false;
          if (edge_type && edge.type !== edge_type) return false;
          return true;
        });

        if (matching.length === 0) {
          const available = node.references
            .filter(
              e =>
                e.type === 'property' ||
                e.type === 'element' ||
                e.type === 'context',
            )
            .slice(0, 20)
            .map(e => `${e.type}:${String(e.name_or_index)}`);
          return textResult(
            `Property "${property_name}" not found on @${node_id} ${node.name}${edge_type ? ` (type filter: ${edge_type})` : ''}\n\nAvailable properties: ${available.join(', ')}`,
          );
        }

        const formatTarget = (
          d: NodeDetail,
          edgeName: string,
          edgeType: string,
        ) => {
          const lines = [
            `**Source:** @${node.id} ${node.name} (${node.type})`,
            `**Edge:** ${edgeName} (${edgeType})`,
            '',
            `**Target ID:** @${d.id}`,
            `**Target Name:** ${d.name}`,
            `**Target Type:** ${d.type}`,
            `**Self Size:** ${formatBytes(d.self_size)}`,
            `**Retained Size:** ${formatBytes(d.retained_size)}`,
            `**Edges Out:** ${formatNumber(d.edge_count)}`,
            `**Referrers:** ${formatNumber(d.referrer_count)}`,
            `**Detached:** ${d.is_detached ? 'Yes' : 'No'}`,
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
          return lines.join('\n');
        };

        if (matching.length === 1) {
          const edge = matching[0];
          const detail = serializeNodeDetail(edge.toNode);
          return textResult(
            formatTarget(detail, String(edge.name_or_index), edge.type),
          );
        }

        // Multiple matches
        const sections = matching.map((edge, i) => {
          const detail = serializeNodeDetail(edge.toNode);
          return `### Match ${i + 1}\n${formatTarget(detail, String(edge.name_or_index), edge.type)}`;
        });
        return textResult(sections.join('\n\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
