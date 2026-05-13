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
import type {IHeapNode, IHeapEdge} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  formatNodeInline,
  formatBytes,
  errorResult,
  textResult,
} from '../utils.js';

export function registerRetainerTrace(server: McpServer): void {
  server.tool(
    'memlab_retainer_trace',
    'Get the shortest path from a GC root to a specific heap node. This shows why the object is retained in memory by walking the pathEdge chain. Use memlab_retainer_summary to trace multiple instances of a class and group by common retainer patterns. Use memlab_get_referrers / memlab_get_references to explore incoming/outgoing edges from a node.',
    {
      node_id: z.number().describe('The numeric ID of the heap node'),
      max_depth: z
        .number()
        .optional()
        .describe(
          'Maximum number of nodes in the trace. When set, shows only the first N nodes from the GC root. Useful for long traces where only the first few hops matter.',
        ),
      show_sizes: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Show retained size at each node in the trace (default true). Makes it easy to see where memory concentrates along the path.',
        ),
    },
    async ({node_id, max_depth, show_sizes}) => {
      try {
        const snapshot = getSnapshot();
        const node = snapshot.getNodeById(node_id);
        if (!node) {
          return errorResult(`Node with id ${node_id} not found`);
        }

        if (!node.hasPathEdge) {
          return textResult(
            'No retainer path available for this node. It may be a root node or unreachable.',
          );
        }

        const visited = new Set<number>([node.id]);
        let curNode: IHeapNode | null = node;

        // Collect path from target to root
        const reverseItems: Array<{
          node: IHeapNode;
          edgeName?: string;
          edgeType?: string;
        }> = [{node: curNode}];

        while (curNode && curNode.hasPathEdge) {
          const edge: IHeapEdge | null = curNode.pathEdge;
          if (!edge) break;
          const fromNode: IHeapNode = edge.fromNode;
          if (visited.has(fromNode.id)) break; // cycle detection
          visited.add(fromNode.id);
          reverseItems.push({
            node: fromNode,
            edgeName: String(edge.name_or_index),
            edgeType: edge.type,
          });
          curNode = fromNode;
        }

        // Reverse to get root-first order
        reverseItems.reverse();

        const fullLength = reverseItems.length;
        const truncated =
          max_depth != null && max_depth > 0 && max_depth < fullLength;
        const items = truncated
          ? reverseItems.slice(0, max_depth)
          : reverseItems;

        const depthNote = truncated
          ? `, showing first ${max_depth} of ${fullLength}`
          : '';
        const lines = [
          `Retainer trace for @${node_id} (${fullLength} nodes${depthNote}):`,
          '',
        ];

        if (show_sizes) {
          // Vertical format with sizes for readability
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const n = item.node;
            const sizeStr = formatBytes(n.retainedSize);
            const nodeStr = formatNodeInline(n.id, n.name, n.type, n.self_size);
            if (i === 0) {
              lines.push(`${nodeStr} [${sizeStr}]`);
            } else {
              const prevItem = items[i - 1];
              const edgeLabel = prevItem.edgeName ?? '?';
              lines.push(`  ← ${edgeLabel} ← ${nodeStr} [${sizeStr}]`);
            }
          }
          if (truncated && max_depth != null) {
            lines.push(`  ← ... (${fullLength - max_depth} more nodes) ...`);
            const target = reverseItems[reverseItems.length - 1];
            const tn = target.node;
            lines.push(
              `  ← ${formatNodeInline(tn.id, tn.name, tn.type, tn.self_size)} [${formatBytes(tn.retainedSize)}]`,
            );
          }
        } else {
          // Compact inline chain format
          const parts: string[] = [];
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            parts.push(
              formatNodeInline(
                item.node.id,
                item.node.name,
                item.node.type,
                item.node.self_size,
              ),
            );
            if (item.edgeName != null && i < items.length - 1) {
              parts.push(` --${item.edgeName}--> `);
            }
          }
          if (truncated && max_depth != null) {
            parts.push(
              ` --...--> (${fullLength - max_depth} more nodes) --...--> `,
            );
            const target = reverseItems[reverseItems.length - 1];
            parts.push(
              formatNodeInline(
                target.node.id,
                target.node.name,
                target.node.type,
                target.node.self_size,
              ),
            );
          }
          lines.push(parts.join(''));
        }

        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
