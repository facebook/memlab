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
import {toolResult, formatBytes, formatNumber} from '../utils.js';

/**
 * Walk a repeated linked structure and report its depth and what it captures.
 *
 * Chains are everywhere in a leaking heap — a wrapper closure that folds the
 * previous one in, a React update queue's `next` list, an LRU's `prev`/`next`,
 * a tree of range nodes under `l`/`r` — and there was no tool for them, so each
 * one got hand-written as an eval. That is slow and, more to the point, it is
 * where the counting goes wrong: the natural loop counts *occurrences* of a
 * captured object rather than *distinct* objects, and a chain that captures the
 * same element at several links then reads as many separate leaked elements. On
 * a measured capture a hand-rolled walk reported "6 links pinning 6 distinct
 * detached divs" for a chain that pinned 2, and the wrong number was published
 * before it was caught.
 *
 * So this returns distinct sets by construction, and reports occurrences
 * separately when they differ.
 */
interface LinkReport {
  depth: number;
  nodeId: number;
  name: string;
  retained: number;
  captured: Array<{edge: string; id: number; name: string; detached: boolean}>;
}

export function registerChainWalk(server: McpServer): void {
  server.tool(
    'memlab_chain_walk',
    'Walk a repeated linked structure from a starting node and report how deep it goes and what it holds — for closure chains (`begin` -> `context` -> `.prev` -> ...), React update queues (`.next`), LRU lists (`.next`/`.prev`), and range/interval trees (`.l`/`.r`). ' +
      'Exists because these get hand-written as evals, and the hand-written version reliably miscounts: it counts how many TIMES an object is captured rather than how many DISTINCT objects are captured, so a chain that pins the same element at several links reads as that many separate leaks. Measured case: a hand-rolled walk reported 6 distinct detached elements for a 6-link chain that pinned 2. ' +
      'This returns distinct sets by construction and reports the occurrence count alongside only when the two differ. Cycles are detected and reported rather than walked forever. ' +
      'Use it after a retainer trace shows the same edge name repeating — that repetition is the signal that a chain, not a single object, is the finding.',
    {
      start_id: z
        .number()
        .describe('Node id to start from (the object holding the chain head).'),
      head_edge: z
        .string()
        .optional()
        .describe(
          'Optional edge to step through first, from `start_id` to the first link (e.g. "begin"). Omit if `start_id` IS the first link.',
        ),
      next_edges: z
        .array(z.string())
        .min(1)
        .describe(
          'Edge name(s) that advance one link. One name walks a list ("next", "prev", "p"); several walk a tree ("l", "r"), in which case every branch is followed and `depth` is the maximum depth reached.',
        ),
      capture_edges: z
        .array(z.string())
        .optional()
        .default([])
        .describe(
          'Edges to record at each link — what the chain is holding onto. Omit to record every named property of each link, which is the right default when you do not yet know what it captures.',
        ),
      max_links: z
        .number()
        .optional()
        .default(10000)
        .describe(
          'Safety bound on links visited (default 10000). A chain longer than this is itself the finding; the result says it was truncated.',
        ),
      show_links: z
        .number()
        .optional()
        .default(3)
        .describe('How many individual links to detail (default 3).'),
    },
    async ({
      start_id,
      head_edge,
      next_edges,
      capture_edges,
      max_links,
      show_links,
    }) => {
      const snapshot = getSnapshot();
      if (!snapshot) {
        return toolResult(
          'Error: No heap snapshot loaded. Use memlab_load_snapshot first.',
        );
      }
      const start = snapshot.getNodeById(start_id);
      if (!start) {
        return toolResult(`Error: node @${start_id} not found.`);
      }

      const edgeTarget = (node: IHeapNode, name: string): IHeapNode | null => {
        for (const e of node.references) {
          if (String(e.name_or_index) === name) return e.toNode;
        }
        return null;
      };

      let head: IHeapNode | null = start;
      if (head_edge != null && head_edge !== '') {
        head = edgeTarget(start, head_edge);
        if (!head) {
          return toolResult(
            `Error: @${start_id} has no edge \`${head_edge}\`. Check the edge name with memlab_object_shape({node_id: ${start_id}}).`,
          );
        }
      }

      const seen = new Set<number>();
      const links: LinkReport[] = [];
      // Distinct captured objects across the WHOLE chain — the number that is
      // usually wanted and usually got wrong.
      const distinctCaptured = new Map<
        number,
        {name: string; detached: boolean; occurrences: number}
      >();
      let occurrences = 0;
      let cyclic = false;
      let truncated = false;
      let maxDepth = 0;

      const stack: Array<{node: IHeapNode; depth: number}> = [
        {node: head, depth: 1},
      ];
      while (stack.length > 0) {
        const entry = stack.pop();
        if (!entry) break;
        const {node, depth} = entry;
        if (seen.has(node.id)) {
          cyclic = true;
          continue;
        }
        if (seen.size >= max_links) {
          truncated = true;
          break;
        }
        seen.add(node.id);
        maxDepth = Math.max(maxDepth, depth);

        const captured: LinkReport['captured'] = [];
        for (const e of node.references) {
          const edgeName = String(e.name_or_index);
          if (next_edges.includes(edgeName)) continue;
          const wanted =
            capture_edges.length > 0
              ? capture_edges.includes(edgeName)
              : e.type === 'property' || e.type === 'context';
          if (!wanted) continue;
          const t = e.toNode;
          captured.push({
            edge: edgeName,
            id: t.id,
            name: t.name,
            detached: Boolean(t.is_detached),
          });
          occurrences++;
          const prev = distinctCaptured.get(t.id);
          if (prev) {
            prev.occurrences++;
          } else {
            distinctCaptured.set(t.id, {
              name: t.name,
              detached: Boolean(t.is_detached),
              occurrences: 1,
            });
          }
        }
        if (links.length < show_links) {
          links.push({
            depth,
            nodeId: node.id,
            name: node.name,
            retained: node.retainedSize,
            captured: captured.slice(0, 8),
          });
        }
        for (const edgeName of next_edges) {
          const nxt = edgeTarget(node, edgeName);
          if (nxt) stack.push({node: nxt, depth: depth + 1});
        }
      }

      const detachedDistinct = [...distinctCaptured.values()].filter(
        c => c.detached,
      ).length;

      const out: string[] = [
        `## Chain from @${start_id}${head_edge ? ` via \`.${head_edge}\`` : ''}`,
        '',
        `- **Links walked: ${formatNumber(seen.size)}** (max depth ${formatNumber(maxDepth)})`,
        `- Distinct objects captured: **${formatNumber(distinctCaptured.size)}**` +
          (occurrences !== distinctCaptured.size
            ? ` — from ${formatNumber(occurrences)} capture occurrences, so the same object is held at several links. Quote the DISTINCT count; the occurrence count is what a hand-written walk reports by mistake.`
            : ''),
        `- Distinct captured objects that are detached DOM: **${formatNumber(detachedDistinct)}**`,
      ];
      if (cyclic) {
        out.push(
          '- ⚠ The chain revisits a node it already walked: it is cyclic, not a list. Depth is the number of distinct links, not a loop count.',
        );
      }
      if (truncated) {
        out.push(
          `- ⚠ Stopped at the ${formatNumber(max_links)}-link bound; the real chain is longer. That length is itself the finding.`,
        );
      }
      if (seen.size === 1) {
        out.push(
          '',
          `> Only one link: nothing advanced through ${next_edges.map(e => `\`${e}\``).join(' / ')}. Either this is not a chain, or the advancing edge has a different name — check with memlab_object_shape({node_id: ${start_id}}).`,
        );
      }

      if (links.length > 0) {
        out.push('', '### First links', '');
        for (const l of links) {
          out.push(
            `**Link ${l.depth}** — @${l.nodeId} \`${l.name}\` (${formatBytes(l.retained)} retained)`,
          );
          if (l.captured.length === 0) {
            out.push('  - captures nothing named');
          }
          for (const c of l.captured) {
            out.push(
              `  - \`${c.edge}\` → @${c.id} ${c.name}${c.detached ? ' **[DETACHED]**' : ''}`,
            );
          }
        }
      }

      const top = [...distinctCaptured.entries()]
        .sort((a, b) => b[1].occurrences - a[1].occurrences)
        .slice(0, 8);
      if (top.length > 0) {
        out.push('', '### Distinct captured objects (most-held first)', '');
        for (const [nodeId, info] of top) {
          out.push(
            `- @${nodeId} \`${info.name}\`${info.detached ? ' **[DETACHED]**' : ''} — held at ${formatNumber(info.occurrences)} link(s)`,
          );
        }
      }

      out.push(
        '',
        "_Depth alone is not a leak: a bounded structure has a depth too. What makes a chain a finding is that it grows per interaction and nothing removes links — check that with `memlab_ladder_probe` over a ladder, using this tool's link count as the metric._",
      );
      return toolResult(out.join('\n'));
    },
  );
}
