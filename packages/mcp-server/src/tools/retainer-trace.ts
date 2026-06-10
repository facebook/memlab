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
  isNodeWorthInspecting,
  instrumentationRetainerNote,
  errorResult,
  toolResult,
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
      expand: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Expand the elided middle: show every node on the path instead of collapsing consecutive V8/internal runs. Use when the interesting library/application boundary is hidden inside a "… N internal node(s) …" gap.',
        ),
    },
    async ({node_id, max_depth, show_sizes, expand}) => {
      try {
        const snapshot = getSnapshot();
        const node = snapshot.getNodeById(node_id);
        if (!node) {
          return errorResult(`Node with id ${node_id} not found`);
        }

        if (!node.hasPathEdge) {
          const isRoot =
            node.id <= 3 ||
            node.name === '(GC roots)' ||
            node.name === '(Strong roots)';
          const hasReferrers = node.numOfReferrers > 0;
          if (isRoot) {
            return toolResult(
              `@${node_id} is a GC root node (${node.name}) — it has no retainer because it is itself a root of the object graph.`,
            );
          }
          if (hasReferrers) {
            return toolResult(
              `@${node_id} (${node.name}, ${node.type}) has ${node.numOfReferrers} referrer(s) but no computed shortest path to a GC root. ` +
                `This can happen when the dominator tree was computed with a different root set, or when the node is reachable only through weak references. ` +
                `Use \`memlab_get_referrers\` with node_id ${node_id} to manually trace its incoming edges.`,
            );
          }
          return toolResult(
            `@${node_id} (${node.name}, ${node.type}) has no retainer path and no referrers — it is likely eligible for garbage collection ` +
              `and retained only because a GC cycle hasn't reclaimed it yet. It is safe to ignore for leak investigation.`,
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

        // Collapse consecutive internal/V8 nodes for readability, unless the
        // caller asked to expand the full path (Feedback §3c).
        const collapsed: Array<{
          node: IHeapNode;
          edgeName?: string;
          edgeType?: string;
          collapsedCount?: number;
        }> = [];
        if (expand) {
          collapsed.push(...reverseItems);
        } else {
          let internalRun = 0;
          for (const item of reverseItems) {
            if (!isNodeWorthInspecting(item.node) && collapsed.length > 0) {
              internalRun++;
            } else {
              if (internalRun > 0) {
                collapsed.push({
                  node: item.node,
                  edgeName: item.edgeName,
                  edgeType: item.edgeType,
                  collapsedCount: internalRun,
                });
                internalRun = 0;
              } else {
                collapsed.push(item);
              }
            }
          }
          if (internalRun > 0 && collapsed.length > 0) {
            const last = collapsed[collapsed.length - 1];
            last.collapsedCount = (last.collapsedCount ?? 0) + internalRun;
          }
        }

        // Highlight the application/library boundary: the node closest to the
        // target that has a source location (i.e. user/app code, not a V8
        // internal). Helps when the boundary is otherwise buried in the path.
        let appFrame: IHeapNode | null = null;
        for (let i = reverseItems.length - 1; i >= 0; i--) {
          const n = reverseItems[i].node;
          if (n.location && isNodeWorthInspecting(n)) {
            appFrame = n;
            break;
          }
        }

        const fullLength = reverseItems.length;
        const truncated =
          max_depth != null && max_depth > 0 && max_depth < fullLength;
        const items = truncated ? collapsed.slice(0, max_depth) : collapsed;

        const depthNote = truncated
          ? `, showing first ${max_depth} of ${fullLength}`
          : '';
        const lines = [
          `Retainer trace for @${node_id} (${fullLength} nodes${depthNote}):`,
          '',
        ];
        if (appFrame) {
          const loc = appFrame.location;
          lines.push(
            `First source-located (app) frame: @${appFrame.id} ${formatNodeInline(appFrame.id, appFrame.name, appFrame.type, appFrame.self_size)}` +
              (loc
                ? ` — script ${loc.script_id}:${loc.line}:${loc.column}`
                : ''),
            '',
          );
        }

        // Flag paths that only reach this node through instrumentation
        // (patched console / OTel context), which misleads "who owns it"
        // (Feedback §3a).
        const instrNote = instrumentationRetainerNote(
          reverseItems.map(it => ({
            name: it.node.name,
            edgeName: it.edgeName,
          })),
        );
        if (instrNote) {
          lines.push(`⚠ ${instrNote}`, '');
        }

        if (show_sizes) {
          // Vertical format with sizes for readability
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const n = item.node;
            const sizeStr = formatBytes(n.retainedSize);
            const nodeStr = formatNodeInline(n.id, n.name, n.type, n.self_size);
            if (item.collapsedCount && item.collapsedCount > 0) {
              lines.push(`  ← [${item.collapsedCount} internal node(s)] ←`);
            }
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

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
