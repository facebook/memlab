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
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {tickAnalysis} from '../analysis-budget.js';
import {getSnapshot} from '../heap-state.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  isNodeWorthInspecting,
  markdownTable,
  toolResult,
} from '../utils.js';

interface Hop {
  node: IHeapNode;
  /** Fraction of the PARENT's retained size this node accounts for. */
  share: number;
  /**
   * How many dominated children the parent had in total, INCLUDING this one —
   * i.e. how many candidates the hop chose between, so a reader can tell a
   * forced hop (1) from a real pick.
   */
  children: number;
}

interface HeaviestChild {
  /** Id, not the node: see `indexHeaviestChildren`. */
  bestId: number;
  bestRetained: number;
  children: number;
}

/**
 * For EVERY node: its heaviest dominator-tree child and how many children it
 * had to choose from — built in a single pass.
 *
 * The walk asks the same question once per hop, and answering it with its own
 * O(N) scan made the tool O(N x depth): up to 24 full passes over a
 * multi-million-node graph for one call. One pass costs the same as the first
 * hop used to and makes every subsequent hop O(1), so the tool is O(N) whatever
 * the depth.
 *
 * The index stores ids and sizes rather than `IHeapNode`s deliberately. There is
 * one entry per node that dominates anything, which on the multi-million-node
 * graphs this is built for is millions of entries, and this runs inside a
 * process already holding the parsed snapshot. Numbers keep the index to plain
 * scalars; the walk consults at most `max_depth` of those entries, so it pays
 * for the handful of `getNodeById` lookups it actually needs instead of
 * retaining a node wrapper for every parent in the graph.
 */
function indexHeaviestChildren(
  snapshot: IHeapSnapshot,
): Map<number, HeaviestChild> {
  const byParent = new Map<number, HeaviestChild>();
  snapshot.nodes.forEach(node => {
    tickAnalysis();
    const parent = node.dominatorNode;
    if (parent == null || parent.id === node.id) return;
    const entry = byParent.get(parent.id);
    if (entry == null) {
      byParent.set(parent.id, {
        bestId: node.id,
        bestRetained: node.retainedSize,
        children: 1,
      });
      return;
    }
    entry.children++;
    if (node.retainedSize > entry.bestRetained) {
      entry.bestId = node.id;
      entry.bestRetained = node.retainedSize;
    }
  });
  return byParent;
}

/** Entry count and a size sample for whatever the chain bottomed out on. */
function describeTerminal(node: IHeapNode): string[] {
  const out: string[] = [];
  let elements = 0;
  let properties = 0;
  const sample: Array<{name: string; size: number}> = [];
  for (const edge of node.references) {
    if (edge.type === 'element') elements++;
    else if (edge.type === 'property') properties++;
    else continue;
    if (sample.length < 5) {
      sample.push({
        name: String(edge.name_or_index),
        size: edge.toNode?.retainedSize ?? 0,
      });
    }
  }
  if (elements > 0) {
    out.push(
      `**${formatNumber(elements)} elements**${properties > 0 ? ` and ${formatNumber(properties)} properties` : ''}.`,
    );
  } else if (properties > 0) {
    out.push(
      `**${formatNumber(properties)} properties**, no indexed elements.`,
    );
  }
  if (sample.length > 0) {
    out.push(
      '',
      markdownTable(
        ['Edge', 'Target retained'],
        sample.map(s => [`\`${s.name}\``, formatBytes(s.size)]),
      ),
    );
  }
  return out;
}

export function registerDrillToHeavyLeaf(server: McpServer): void {
  server.tool(
    'memlab_drill_to_heavy_leaf',
    'Follow the retained size DOWN from one node to the object actually holding it, in a single call.\n\n' +
      'A large retained size usually sits on a wrapper — a closure context, then the object it captured, then the ' +
      'array inside that object — and each hop has exactly one child carrying essentially all the weight. Finding the ' +
      'bottom means calling `memlab_dominator_subtree` once per hop and reading one row of each table; three or four ' +
      'round-trips to learn one fact. This walks the chain server-side while a single child keeps ≥`threshold` of the ' +
      'parent, stops at the first real BRANCH (where the weight genuinely splits) or at a leaf, and reports the whole ' +
      'chain plus the terminal object’s entry count and a size sample.\n\n' +
      'The branch point is the answer as often as the leaf is: it is where "one big thing" becomes "many things", ' +
      'which is where a fix has to choose what to bound.',
    {
      node_id: z
        .number()
        .describe(
          'Node to start from — typically a row from memlab_largest_objects.',
        ),
      threshold: z
        .number()
        .min(0.5)
        .max(1)
        .optional()
        .default(0.8)
        .describe(
          'Keep descending while the heaviest single child retains at least this fraction of its parent (default 0.8). Lower it to follow a chain that sheds weight gradually; raise it to stop the moment the weight is genuinely shared.',
        ),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(24)
        .optional()
        .default(8)
        .describe(
          'Maximum hops to follow (default 8). The dominator index is built in a single pass regardless of depth, so this bounds how far the chain is followed, not the scan cost.',
        ),
    },
    async ({node_id, threshold, max_depth}) => {
      try {
        const snapshot = getSnapshot();
        const start = snapshot.getNodeById(node_id);
        if (!start) return errorResult(`Node with id ${node_id} not found`);

        const heaviestByParent = indexHeaviestChildren(snapshot);
        const chain: Hop[] = [{node: start, share: 1, children: 0}];
        let current = start;
        let stopReason = `hit the ${max_depth}-hop limit`;

        for (let depth = 0; depth < max_depth; depth++) {
          const parentRetained = current.retainedSize;
          if (parentRetained <= 0) {
            stopReason = 'the current node retains nothing further';
            break;
          }
          const entry = heaviestByParent.get(current.id);
          const best =
            entry != null ? snapshot.getNodeById(entry.bestId) : null;
          if (entry == null || best == null) {
            stopReason = 'this node dominates nothing — it is a leaf';
            break;
          }
          const children = entry.children;
          const share = best.retainedSize / parentRetained;
          if (share < threshold) {
            // Not a failure: this is the branch point, and it is frequently the
            // most useful thing the walk finds. Report it as a destination
            // rather than as "the walk gave up".
            stopReason =
              `the weight SPLITS here — the heaviest of ${formatNumber(children)} dominated ` +
              `child(ren) holds only ${(share * 100).toFixed(1)}% of its parent, below the ` +
              `${(threshold * 100).toFixed(0)}% threshold`;
            break;
          }
          chain.push({node: best, share, children});
          current = best;
        }

        const lines: string[] = [
          `## Drill from @${start.id} — ${chain.length - 1} hop(s) followed`,
          '',
        ];

        lines.push(
          markdownTable(
            ['Hop', 'Node', 'Type', 'Retained', '% of parent', 'Chosen from'],
            chain.map((h, i) => [
              String(i),
              `@${h.node.id} ${h.node.name}`,
              h.node.type,
              formatBytes(h.node.retainedSize),
              i === 0 ? '—' : `${(h.share * 100).toFixed(1)}%`,
              i === 0 ? '—' : formatNumber(h.children),
            ]),
          ),
          '',
        );

        const terminal = chain[chain.length - 1].node;
        lines.push(`**Stopped because** ${stopReason}.`, '');
        lines.push(
          `**Terminal object:** @${terminal.id} \`${terminal.name}\` (${terminal.type}), ` +
            `self ${formatBytes(terminal.self_size)}, retained ${formatBytes(terminal.retainedSize)}.`,
        );
        const detail = describeTerminal(terminal);
        if (detail.length > 0) lines.push(...detail);

        if (chain.length === 1) {
          // A one-node chain has three different causes and they need three
          // different next steps. Asserting "this node is the branch point"
          // unconditionally contradicts the stop reason printed just above when
          // the node is a leaf or retains nothing.
          lines.push(
            '',
            start.retainedSize <= 0
              ? '_No hop was taken: the starting node retains nothing, so there is no weight to follow. ' +
                  'Pick a node with a non-zero retained size._'
              : stopReason.startsWith('this node dominates nothing')
                ? '_No hop was taken: the starting node dominates nothing — it is a leaf of the dominator ' +
                  'tree, so there is nothing below it to drill into._'
                : '_No hop was taken: the weight is already split at the starting node, so this node ' +
                  'is itself the branch point. `memlab_dominator_subtree` will show how it divides._',
          );
        }
        if (!isNodeWorthInspecting(terminal)) {
          lines.push(
            '',
            '_The terminal node is an internal/V8 structure. That usually means the interesting ' +
              'owner is the hop ABOVE it — read the chain from the bottom up._',
          );
        }

        lines.push(
          '',
          '_This follows dominators, so every hop is memory held EXCLUSIVELY through the one above. ' +
            'It answers "what is holding these bytes", not "why is it reachable" — use ' +
            '`memlab_retainer_trace` on the terminal node for the path from a GC root._',
        );

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
