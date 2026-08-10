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
import type {IHeapEdge, IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  isNodeWorthInspecting,
  markdownTable,
  toolResult,
  truncateNodeName,
} from '../utils.js';

/**
 * Reachability from the synthetic GC roots with one node treated as a sink:
 * `blocked` is marked reached (so it is not reported as unreachable) but its
 * outgoing edges are never followed. Anything left unmarked is reachable ONLY
 * through `blocked`, i.e. it lives inside that node's retained subtree.
 *
 * Mirrors `computeReachableWithoutDevRoots` in dev-artifacts.ts, which does the
 * same walk with the dev/automation roots as sinks.
 */
export function computeReachableWithoutNode(
  snapshot: IHeapSnapshot,
  blockedId: number,
): Uint8Array {
  const reached = new Uint8Array(snapshot.nodes.length);
  const stack: IHeapNode[] = [];
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.type !== 'synthetic' && node.id > 3) return;
    if (reached[node.nodeIndex]) return;
    reached[node.nodeIndex] = 1;
    if (node.id !== blockedId) stack.push(node);
  });
  while (stack.length > 0) {
    const node = stack.pop() as IHeapNode;
    node.forEachReference((edge: IHeapEdge) => {
      const to = edge.toNode;
      if (reached[to.nodeIndex]) return;
      reached[to.nodeIndex] = 1;
      if (to.id !== blockedId) stack.push(to);
    });
  }
  return reached;
}

interface RetainerEdgeGroup {
  fromName: string;
  fromType: string;
  edgeName: string;
  edgeType: string;
  count: number;
  exampleFromId: number;
  maxRetained: number;
}

function groupKey(g: {
  fromName: string;
  fromType: string;
  edgeName: string;
  edgeType: string;
}): string {
  return `${g.fromType}\u0000${g.fromName}\u0000${g.edgeType}\u0000${g.edgeName}`;
}

export function registerRetainerLayers(server: McpServer): void {
  server.tool(
    'memlab_retainer_layers',
    'Counterfactual retainer analysis: answer "if I cut this edge, would the object still be retained, and by what?". ' +
      "Enumerates the INDEPENDENT retaining edges into a node — the incoming edges whose source is still reachable from a GC root when the target itself is treated as a sink — so back-edges from inside the target's own retained subtree are excluded. " +
      'The object becomes unreachable only when ALL independent retainers are cut, so a count above 1 means any single fix leaves it retained by the others. ' +
      'Use this BEFORE writing a fix: memlab_retainer_trace and memlab_detached_dom --group_by retainer each report ONE path/grouping, which is why a stack of caches holding the same object looks like a single retainer and a partial fix reports a misleading win. ' +
      'Complements memlab_dominator_chain (accountability chain upward) and memlab_retainer_trace (one shortest path).',
    {
      node_id: z
        .number()
        .int()
        .describe('The numeric ID of the heap node to analyze'),
      max_retainers: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(20)
        .describe(
          'Maximum number of distinct retainer groups to list (default 20). Grouping is by (source class, source type, edge name, edge type).',
        ),
    },
    async ({node_id, max_retainers}) => {
      try {
        const snapshot = getSnapshot();
        const target = snapshot.getNodeById(node_id);
        if (!target) {
          return errorResult(`Node with id ${node_id} not found`);
        }

        const reached = computeReachableWithoutNode(snapshot, target.id);

        // Partition incoming edges into independent retainers (source still
        // reachable with the target blocked) and internal back-edges (source
        // only reachable through the target).
        const groups = new Map<string, RetainerEdgeGroup>();
        let independentEdgeCount = 0;
        let backEdgeCount = 0;
        for (const edge of target.referrers) {
          const from = edge.fromNode;
          // A self-edge (V8 emits them for DOM nodes) cannot retain the target,
          // but the sink walk marks the target itself reached so it would
          // otherwise pass the test below. Count it with the back-edges.
          if (from.id === target.id || !reached[from.nodeIndex]) {
            backEdgeCount++;
            continue;
          }
          independentEdgeCount++;
          const g = {
            fromName: from.name,
            fromType: from.type,
            edgeName: String(edge.name_or_index),
            edgeType: edge.type,
          };
          const key = groupKey(g);
          const existing = groups.get(key);
          if (existing) {
            existing.count++;
            if (from.retainedSize > existing.maxRetained) {
              existing.maxRetained = from.retainedSize;
              existing.exampleFromId = from.id;
            }
          } else {
            groups.set(key, {
              ...g,
              count: 1,
              exampleFromId: from.id,
              maxRetained: from.retainedSize,
            });
          }
        }

        const sorted = [...groups.values()].sort(
          (a, b) => b.maxRetained - a.maxRetained || b.count - a.count,
        );
        const shown = sorted.slice(0, max_retainers);

        const targetLabel = truncateNodeName(
          target.name,
          target.type,
          target.self_size,
          60,
        );
        const lines: string[] = [
          `## Retainer layers for @${target.id} (${targetLabel})`,
          '',
          `Retained ${formatBytes(target.retainedSize)}. ` +
            `${formatNumber(independentEdgeCount)} independent retaining edge(s) in ${formatNumber(sorted.length)} group(s)` +
            (backEdgeCount > 0
              ? `; ${formatNumber(backEdgeCount)} back-edge(s) from inside its own retained subtree excluded.`
              : '.'),
          '',
        ];

        if (independentEdgeCount === 0) {
          lines.push(
            target.type === 'synthetic' || target.id <= 3
              ? '**This node is a GC root itself** — it has no external retainer to cut.'
              : "**No independent retainer found.** Nothing outside this object's own subtree references it, so it is already GC-eligible (or reachable only via weak references). It should not be counted toward a leak total — see `memlab_detached_dom --only_with_retainer_path`.",
          );
          return toolResult(lines.join('\n'));
        }

        // The counterfactual verdict. Cutting one independent edge cannot change
        // the reachability of any other independent source, because every such
        // source is reachable on a path that does not pass through the target.
        if (independentEdgeCount === 1) {
          const only = sorted[0];
          lines.push(
            `**Sole retainer — cutting it frees the object.** \`${only.edgeName}\` (${only.edgeType}) from @${only.exampleFromId} ${only.fromName} (${only.fromType}). ` +
              `Fixing this one reference reclaims ${formatBytes(target.retainedSize)}.`,
            '',
          );
        } else {
          lines.push(
            `**${formatNumber(independentEdgeCount)} independent retainers — cutting any ONE leaves the object retained by the other ${formatNumber(independentEdgeCount - 1)}.** ` +
              'A fix that removes a single one of these will show little or no memory win, and a before/after measurement that attributes the whole object to the removed retainer will overstate the result. ' +
              'All of them must be cut to reclaim the object.',
            '',
          );
        }

        lines.push(
          markdownTable(
            ['#', 'edges', 'from', 'edge', 'example', 'source retains'],
            shown.map((g, i) => [
              String(i + 1),
              formatNumber(g.count),
              `${g.fromName} (${g.fromType})`,
              `${g.edgeName} (${g.edgeType})`,
              `@${g.exampleFromId}`,
              formatBytes(g.maxRetained),
            ]),
          ),
        );
        if (sorted.length > shown.length) {
          lines.push(
            '',
            `_${formatNumber(sorted.length - shown.length)} more retainer group(s) not shown — raise max_retainers to see them._`,
          );
        }

        // A dominator that is not the GC-roots super-node means every path to
        // the target passes through it, so it is a single choke point even when
        // several independent edges exist.
        const dom = target.dominatorNode;
        if (
          independentEdgeCount > 1 &&
          dom &&
          dom.id !== target.id &&
          dom.name !== '(GC roots)' &&
          isNodeWorthInspecting(dom)
        ) {
          lines.push(
            '',
            `**Single choke point:** every path still passes through the immediate dominator @${dom.id} ${truncateNodeName(dom.name, dom.type, dom.self_size, 60)} (retains ${formatBytes(dom.retainedSize)}). ` +
              'Cutting there frees the target in one change instead of cutting each retainer. Use `memlab_dominator_chain` to walk further up.',
          );
        }

        lines.push(
          '',
          '_Independence test: an incoming edge counts only if its source is still reachable from a GC root when the target is treated as a sink. ' +
            "Edges failing that test originate inside the target's own retained subtree and cannot keep it alive._",
        );

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
