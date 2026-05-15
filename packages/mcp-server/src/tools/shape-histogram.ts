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
import type {IHeapNode, HeapNodeIdSet} from '@memlab/core';
import memlabCore from '@memlab/core';
const {utils, NumericSet} = memlabCore;
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {formatBytes, formatNumber, errorResult, toolResult} from '../utils.js';

interface ShapeGroup {
  properties: string[];
  count: number;
  totalSelfSize: number;
  nodeIds: HeapNodeIdSet;
  exampleNodeId: number;
}

function getPropertyNames(node: IHeapNode): string[] | null {
  const names: string[] = [];
  for (const edge of node.references) {
    if (edge.type === 'property') {
      names.push(String(edge.name_or_index));
    }
  }
  if (names.length === 0) return null;
  names.sort();
  return names;
}

export function registerShapeHistogram(server: McpServer): void {
  server.tool(
    'memlab_shape_histogram',
    'Group objects by their property structure (shape/hidden class). Objects with the same set of property names are grouped together, revealing distinct record types. Much more useful than class_histogram when most objects are generic "Object" — this tells you exactly what data structures exist and how much memory each shape consumes. Essential for data-heavy apps where millions of "Object" instances hide 3-5 distinct record shapes.',
    {
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of shapes to return (default 20)'),
      min_count: z
        .number()
        .optional()
        .default(2)
        .describe('Minimum instance count to include (default 2)'),
      min_retained_size: z
        .number()
        .optional()
        .describe(
          'Minimum aggregate retained size in bytes to include (e.g., 1048576 for 1 MB)',
        ),
      class_name: z
        .string()
        .optional()
        .describe(
          'Filter to objects with this constructor name (e.g., "Object"). If omitted, includes all object-type nodes.',
        ),
    },
    async ({limit, min_count, min_retained_size, class_name}) => {
      try {
        const snapshot = getSnapshot();
        const shapeMap = new Map<string, ShapeGroup>();

        snapshot.nodes.forEach(node => {
          if (node.type !== 'object') return;
          if (node.id <= 3) return;
          if (class_name && node.name !== class_name) return;

          const props = getPropertyNames(node);
          if (!props) return;

          const key = props.join(',');
          const existing = shapeMap.get(key);
          if (existing) {
            existing.count++;
            existing.totalSelfSize += node.self_size;
            existing.nodeIds.add(node.id);
          } else {
            shapeMap.set(key, {
              properties: props,
              count: 1,
              totalSelfSize: node.self_size,
              nodeIds: new NumericSet([node.id]),
              exampleNodeId: node.id,
            });
          }
        });

        const filtered = [...shapeMap.values()].filter(
          g => g.count >= min_count,
        );

        const withRetained = filtered.map(g => {
          const retainedSize = utils.aggregateDominatorMetrics(
            g.nodeIds,
            snapshot,
            () => true,
            (node: IHeapNode) => node.retainedSize,
          );
          return {...g, retainedSize};
        });

        let finalList = withRetained;
        if (min_retained_size != null) {
          finalList = finalList.filter(
            g => g.retainedSize >= min_retained_size,
          );
        }

        finalList.sort((a, b) => b.retainedSize - a.retainedSize);
        finalList = finalList.slice(0, limit);

        if (finalList.length === 0) {
          return toolResult(
            'No object shapes found matching the criteria. Try lowering min_count or removing class_name filter.',
          );
        }

        const lines: string[] = [
          `## Object Shape Histogram`,
          `${formatNumber(shapeMap.size)} distinct shapes found, showing top ${finalList.length}`,
          '',
        ];

        for (let i = 0; i < finalList.length; i++) {
          const g = finalList[i];
          const propsDisplay =
            g.properties.length <= 8
              ? `{${g.properties.join(', ')}}`
              : `{${g.properties.slice(0, 6).join(', ')}, … +${g.properties.length - 6} more}`;

          lines.push(
            `${i + 1}. **${propsDisplay}** — ${formatNumber(g.count)} instances, ${formatBytes(g.retainedSize)} retained, ${formatBytes(g.totalSelfSize)} self`,
          );
          lines.push(`   Example: @${g.exampleNodeId}`);
        }

        lines.push('', '**Suggested next steps:**');
        const top = finalList[0];
        lines.push(
          `- Inspect example: \`memlab_object_shape(${top.exampleNodeId})\``,
        );
        lines.push(
          `- Trace retention: \`memlab_retainer_trace(${top.exampleNodeId})\``,
        );
        if (finalList.length > 1) {
          lines.push(
            `- Compare shapes: \`memlab_object_shape\` on examples from different shapes`,
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
