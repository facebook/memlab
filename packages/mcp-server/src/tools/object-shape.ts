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
  formatBytes,
  formatNumber,
  formatNodeInline,
  markdownTable,
  errorResult,
  textResult,
  toolResult,
} from '../utils.js';

export function registerObjectShape(server: McpServer): void {
  server.tool(
    'memlab_object_shape',
    'Show the shape/structure of one or more heap objects: all named properties with target node types and sizes. Filters out internal/hidden edges to show only user-visible properties. Supports batch inspection via node_ids to compare multiple objects side-by-side in a single call.',
    {
      node_id: z
        .number()
        .optional()
        .describe(
          'The numeric ID of a single heap node. Use node_ids for batch inspection.',
        ),
      node_ids: z
        .array(z.number())
        .optional()
        .describe(
          'Array of node IDs to inspect in a single call (batch mode). Returns shape for each node.',
        ),
      include_internal: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include internal/hidden edges (default false)'),
      non_null_only: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Only show properties whose target is not null/undefined/false/zero. Useful for reducing noise on objects with many empty fields.',
        ),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe(
          'Maximum number of properties to return per node (default 50)',
        ),
    },
    async ({node_id, node_ids, include_internal, non_null_only, limit}) => {
      try {
        const snapshot = getSnapshot();

        const ids: number[] = node_ids ?? (node_id != null ? [node_id] : []);
        if (ids.length === 0) {
          return errorResult('Provide either node_id or node_ids to inspect.');
        }
        if (ids.length > 20) {
          return errorResult(
            'Maximum 20 nodes per batch. Reduce node_ids count.',
          );
        }

        const userEdgeTypes = new Set([
          'property',
          'element',
          'context',
          'shortcut',
        ]);

        const sections: string[] = [];
        for (const id of ids) {
          const node = snapshot.getNodeById(id);
          if (!node) {
            sections.push(`**@${id}** — not found\n`);
            continue;
          }

          const NULL_NAMES = new Set(['null', 'undefined', 'false', '']);
          const filteredEdges = node.references
            .filter(edge => {
              if (!include_internal && !userEdgeTypes.has(edge.type))
                return false;
              if (non_null_only) {
                const target = edge.toNode;
                if (target.id <= 3) return false;
                if (target.type === 'hidden' && target.self_size === 0)
                  return false;
                if (NULL_NAMES.has(target.name) && target.self_size === 0)
                  return false;
                if (
                  target.name === 'Oddball' ||
                  target.name === 'system / Oddball'
                )
                  return false;
                if (target.isString) {
                  const strNode = target.toStringNode();
                  if (strNode) {
                    const val = strNode.stringValue;
                    if (
                      val === '' ||
                      val === '0' ||
                      val === 'false' ||
                      val === 'null' ||
                      val === 'undefined'
                    )
                      return false;
                  }
                }
              }
              return true;
            })
            .sort((a, b) => b.toNode.retainedSize - a.toNode.retainedSize)
            .slice(0, limit);

          const totalEdges = node.references.length;
          const hiddenCount = include_internal
            ? 0
            : totalEdges -
              node.references.filter(e => userEdgeTypes.has(e.type)).length;

          const lines = [
            `**${formatNodeInline(node.id, node.name, node.type, node.self_size)}** — ${formatNumber(totalEdges)} edges total${hiddenCount > 0 ? `, ${formatNumber(hiddenCount)} internal hidden` : ''}`,
            '',
          ];

          const headers = [
            'Name',
            'Edge Type',
            'Target',
            'Target Type',
            'Retained',
          ];
          const rightCols = new Set([4]);
          const rows = filteredEdges.map(edge => {
            const target = edge.toNode;
            let targetLabel = `@${target.id} ${target.name}`;
            if (target.isString) {
              const strNode = target.toStringNode();
              if (strNode) {
                const val = strNode.stringValue;
                targetLabel = `@${target.id} "${val.length > 60 ? val.slice(0, 60) + '...' : val}"`;
              }
            } else if (target.name === 'smi number' && target.self_size === 0) {
              // Decoded SMI value (id >> 1). Include the node id so it can be
              // passed to memlab_get_value if needed (Feedback §1c).
              targetLabel = `${target.id >> 1} (smi int, @${target.id})`;
            } else if (target.name === 'heap number') {
              targetLabel = `@${target.id} (heap number)`;
            }
            return [
              String(edge.name_or_index),
              edge.type,
              targetLabel,
              target.type,
              formatBytes(target.retainedSize),
            ];
          });
          lines.push(markdownTable(headers, rows, rightCols));
          sections.push(lines.join('\n'));
        }

        // Compute property overlap summary for batch mode
        if (ids.length > 1) {
          const nodePropertySets: Array<{id: number; props: Set<string>}> = [];
          for (const id of ids) {
            const node = snapshot.getNodeById(id);
            if (!node) continue;
            const props = new Set<string>();
            for (const edge of node.references) {
              if (edge.type === 'property') {
                props.add(String(edge.name_or_index));
              }
            }
            nodePropertySets.push({id, props});
          }

          if (nodePropertySets.length > 1) {
            // Group nodes by their property set
            const shapeGroups = new Map<string, number[]>();
            for (const {id, props} of nodePropertySets) {
              const key = [...props].sort().join(',');
              const group = shapeGroups.get(key);
              if (group) {
                group.push(id);
              } else {
                shapeGroups.set(key, [id]);
              }
            }

            let overlapSummary: string;
            if (shapeGroups.size === 1) {
              const [key] = shapeGroups.keys();
              const propNames = key.split(',');
              const propsDisplay =
                propNames.length <= 8
                  ? `{${propNames.join(', ')}}`
                  : `{${propNames.slice(0, 6).join(', ')}, ... +${propNames.length - 6}}`;
              overlapSummary = `${nodePropertySets.length} nodes inspected: all share the same ${propNames.length}-property shape ${propsDisplay}`;
            } else {
              const groupDescs: string[] = [];
              for (const [key, groupIds] of shapeGroups) {
                const propNames = key.split(',');
                const propsDisplay =
                  propNames.length <= 6
                    ? `{${propNames.join(', ')}}`
                    : `{${propNames.slice(0, 5).join(', ')}, ... +${propNames.length - 5}}`;
                groupDescs.push(
                  `${groupIds.length} ${groupIds.length === 1 ? 'has' : 'share'} ${propsDisplay}`,
                );
              }
              overlapSummary = `${nodePropertySets.length} nodes: ${groupDescs.join(', ')}`;
            }

            sections.unshift(`**Shape overlap:** ${overlapSummary}`);
          }
        }

        return toolResult(sections.join('\n\n---\n\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
