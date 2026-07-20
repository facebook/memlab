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
import type {IHeapNode} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  isNodeWorthInspecting,
  truncateNodeName,
  errorResult,
  toolResult,
  formatBytes,
  formatNumber,
} from '../utils.js';

export function registerDominatorChain(server: McpServer): void {
  server.tool(
    'memlab_dominator_chain',
    'Walk UPWARD through the immediate-dominator chain from a node to the GC root — the accountability chain of objects that each, if freed, would free the target. Every node on the chain exclusively dominates the target, so the nearest application-owned entry is the single owner to fix. This complements the DOWNWARD memlab_dominator_subtree / memlab_trace_dominators (what a node dominates) and the edge-based memlab_retainer_trace (a shortest reference path, which need not be a dominator). Mirrors the Chrome DevTools "Retained by / dominators" chain. Each step shows retained size and the fan-in (how much extra memory the next dominator is accountable for).',
    {
      node_id: z
        .number()
        .describe('The numeric ID of the heap node to trace upward from'),
      max_depth: z
        .number()
        .optional()
        .default(30)
        .describe('Maximum number of dominator hops to climb (default 30)'),
    },
    async ({node_id, max_depth}) => {
      try {
        const snapshot = getSnapshot();
        const targetNode = snapshot.getNodeById(node_id);
        if (!targetNode) {
          return errorResult(`Node with id ${node_id} not found`);
        }

        // Climb immediate dominators until the GC root (which dominates itself)
        // or a depth/cycle limit is hit.
        const chain: IHeapNode[] = [targetNode];
        const visited = new Set<number>([targetNode.id]);
        let current: IHeapNode = targetNode;
        let reachedRoot = false;
        while (chain.length <= max_depth) {
          const dom = current.dominatorNode;
          if (!dom || dom.id === current.id) {
            reachedRoot = true;
            break;
          }
          if (visited.has(dom.id)) break;
          visited.add(dom.id);
          chain.push(dom);
          current = dom;
        }

        // The nearest dominator ABOVE the target that is a real, inspectable
        // app object — the accountable owner to fix.
        const owner = chain
          .slice(1)
          .find(n => isNodeWorthInspecting(n) && n.name !== '(GC roots)');

        const lines: string[] = [
          `## Dominator chain for @${targetNode.id} (${truncateNodeName(targetNode.name, targetNode.type, targetNode.self_size, 60)})`,
          '',
          `Retained ${formatBytes(targetNode.retainedSize)}. Climbing ${chain.length - 1} immediate dominator(s) toward the GC root${reachedRoot ? '' : ` (stopped at max_depth ${max_depth})`}.`,
          '',
        ];

        for (let i = 0; i < chain.length; i++) {
          const n = chain[i];
          const indent = '  '.repeat(i);
          const name = truncateNodeName(n.name, n.type, n.self_size, 80);
          // Fan-in: how much more the next dominator up is accountable for than
          // this node — i.e. what else it holds besides this subtree.
          let fanIn = '';
          if (i + 1 < chain.length) {
            const delta = chain[i + 1].retainedSize - n.retainedSize;
            if (delta > 0)
              fanIn = ` — dominator holds +${formatBytes(delta)} beyond this`;
          }
          const marker = i === 0 ? 'target' : `↑ dom ${i}`;
          const ownerTag =
            owner && n.id === owner.id ? ' ← nearest app owner' : '';
          lines.push(
            `${indent}[${marker}] @${n.id} ${name} (retained ${formatBytes(n.retainedSize)})${fanIn}${ownerTag}`,
          );
        }

        lines.push('');
        if (reachedRoot) {
          lines.push(
            '_(reached GC root — this is the full accountability chain)_',
          );
        } else {
          lines.push(
            `_(stopped at max_depth ${max_depth}; pass a larger max_depth to reach the root)_`,
          );
        }
        if (owner) {
          lines.push(
            '',
            `**Nearest app owner:** @${owner.id} ${truncateNodeName(owner.name, owner.type, owner.self_size, 60)} — retains ${formatBytes(owner.retainedSize)} (${formatNumber(owner.retainedSize)} bytes). Fixing this object frees the target.`,
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
