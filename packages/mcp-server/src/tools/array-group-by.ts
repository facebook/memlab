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
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';

export function registerArrayGroupBy(server: McpServer): void {
  server.tool(
    'memlab_array_group_by',
    'Iterate through array (or Map/Set) elements, extract a named property from each, and ' +
      'group/count by the target value. Eliminates the most common memlab_eval boilerplate — ' +
      '"iterate array, extract property, group by shape" — in a single tool call. ' +
      'Example: given a listener array where each element has a "context" property, ' +
      'this reports "649× ChatMsgsCollection, 1× MsgCollection, 1× Mirror". ' +
      'Use group_by to control grouping: "name" (constructor name), "type" (node type), or "id" (unique node IDs).',
    {
      node_id: z
        .number()
        .describe(
          'The numeric ID of the Array, Map, or Set node to iterate over',
        ),
      element_property: z
        .string()
        .describe(
          'Property name to extract from each element (e.g., "context", "callback", "key")',
        ),
      group_by: z
        .enum(['name', 'type', 'id'])
        .optional()
        .default('name')
        .describe(
          'How to group the extracted targets: "name" groups by constructor/class name (default), ' +
            '"type" groups by V8 node type, "id" counts unique node IDs',
        ),
      second_property: z
        .string()
        .optional()
        .describe(
          'Optional second property to extract alongside element_property. ' +
            'When set, reports the distribution of the second property within each group. ' +
            'Example: element_property="context", second_property="callback" shows ' +
            'which callbacks are used with each context class.',
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of groups to return (default 20)'),
    },
    async ({node_id, element_property, group_by, second_property, limit}) => {
      try {
        const snapshot = getSnapshot();
        const node = snapshot.getNodeById(node_id);
        if (!node) {
          return errorResult(`Node @${node_id} not found`);
        }

        const elements: Array<{elementNode: typeof node}> = [];

        if (node.name === 'Map' || node.name === 'Set') {
          for (const edge of node.references) {
            if (
              String(edge.name_or_index) === 'table' &&
              edge.toNode.type === 'array'
            ) {
              for (const te of edge.toNode.references) {
                if (te.toNode.id <= 3) continue;
                if (
                  te.toNode.name === 'undefined' ||
                  te.toNode.name === 'the_hole'
                )
                  continue;
                elements.push({elementNode: te.toNode});
              }
              break;
            }
          }
        } else {
          for (const edge of node.references) {
            if (edge.type !== 'element') continue;
            if (edge.toNode.id <= 3) continue;
            elements.push({elementNode: edge.toNode});
          }
        }

        if (elements.length === 0) {
          return toolResult(
            `@${node_id} (${node.name}) has no iterable elements. ` +
              `Make sure this is an Array, Map, or Set node.`,
          );
        }

        const groups = new Map<
          string,
          {
            count: number;
            exampleTargetId: number;
            totalRetained: number;
            secondaryDistribution?: Map<string, number>;
          }
        >();
        let missingProperty = 0;
        let totalElements = 0;

        for (const {elementNode} of elements) {
          totalElements++;
          let targetNode = null;
          let secondTargetNode = null;

          for (const edge of elementNode.references) {
            const eName = String(edge.name_or_index);
            if (eName === element_property) {
              targetNode = edge.toNode;
            }
            if (second_property && eName === second_property) {
              secondTargetNode = edge.toNode;
            }
          }

          if (!targetNode) {
            missingProperty++;
            continue;
          }

          let groupKey: string;
          switch (group_by) {
            case 'type':
              groupKey = targetNode.type;
              break;
            case 'id':
              groupKey = `@${targetNode.id} ${targetNode.name}`;
              break;
            default:
              groupKey = targetNode.name;
          }

          const existing = groups.get(groupKey);
          if (existing) {
            existing.count++;
            existing.totalRetained += targetNode.retainedSize;
            if (second_property && secondTargetNode) {
              if (!existing.secondaryDistribution) {
                existing.secondaryDistribution = new Map();
              }
              const secKey = secondTargetNode.name;
              existing.secondaryDistribution.set(
                secKey,
                (existing.secondaryDistribution.get(secKey) ?? 0) + 1,
              );
            }
          } else {
            const secondaryDist =
              second_property && secondTargetNode
                ? new Map([[secondTargetNode.name, 1]])
                : undefined;
            groups.set(groupKey, {
              count: 1,
              exampleTargetId: targetNode.id,
              totalRetained: targetNode.retainedSize,
              secondaryDistribution: secondaryDist,
            });
          }
        }

        const sorted = [...groups.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, limit);

        const lines = [
          `Property \`${element_property}\` across ${formatNumber(totalElements)} elements of @${node_id} (${node.name}):`,
          '',
        ];

        const headers = [
          group_by === 'id' ? 'Target' : `Target ${group_by}`,
          'Count',
          '%',
          'Total Retained',
          'Example',
        ];
        const rightCols = new Set([1, 2, 3]);
        const rows = sorted.map(([key, info]) => {
          const pct = ((info.count / totalElements) * 100).toFixed(1) + '%';
          return [
            key,
            formatNumber(info.count),
            pct,
            formatBytes(info.totalRetained),
            `@${info.exampleTargetId}`,
          ];
        });

        lines.push(markdownTable(headers, rows, rightCols));

        if (sorted.length < groups.size) {
          lines.push('', `… and ${groups.size - sorted.length} more group(s)`);
        }

        if (missingProperty > 0) {
          lines.push(
            '',
            `${formatNumber(missingProperty)} element(s) missing property \`${element_property}\``,
          );
        }

        if (second_property) {
          const hasSecondary = sorted.some(
            ([, info]) =>
              info.secondaryDistribution && info.secondaryDistribution.size > 0,
          );
          if (hasSecondary) {
            lines.push(
              '',
              `**\`${second_property}\` distribution per group:**`,
            );
            for (const [key, info] of sorted.slice(0, 10)) {
              if (
                !info.secondaryDistribution ||
                info.secondaryDistribution.size === 0
              )
                continue;
              const secSorted = [...info.secondaryDistribution.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5);
              const parts = secSorted.map(
                ([name, count]) => `${count}× ${name}`,
              );
              lines.push(`- ${key}: ${parts.join(', ')}`);
            }
          }
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
