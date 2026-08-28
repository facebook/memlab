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
  nearestFiber,
  fiberComponentName,
  isUpdateRecord,
} from '../react-shapes.js';
import {
  errorResult,
  toolResult,
  formatNumber,
  markdownTable,
  suggestionsSuppressed,
} from '../utils.js';

interface QueueReport {
  queueId: number;
  component: string;
  length: number;
  terminated: 'cycle' | 'end' | 'cap';
}

/**
 * Length of a `queue.pending` chain.
 *
 * React's update queue is CIRCULAR, which is the detail that makes a
 * hand-written walk report its own hop cap as a measurement: a
 * `while (next && next.id !== start)` guarded by `hops < 800` returned 800 for
 * a chain of 2,066, and nothing in the output distinguished the two. The
 * terminator is returned so a capped walk can never be quoted as a length.
 */
function chainLength(
  head: IHeapNode,
  maxHops: number,
): {length: number; terminated: 'cycle' | 'end' | 'cap'} {
  const seen = new Set<number>();
  let cur: IHeapNode | null = head;
  while (cur != null) {
    if (seen.has(cur.id)) return {length: seen.size, terminated: 'cycle'};
    if (seen.size >= maxHops) return {length: seen.size, terminated: 'cap'};
    seen.add(cur.id);
    let next: IHeapNode | null = null;
    for (const edge of cur.references) {
      if (String(edge.name_or_index) !== 'next') continue;
      next = edge.toNode.id > 3 ? edge.toNode : null;
      break;
    }
    cur = next;
  }
  return {length: seen.size, terminated: 'end'};
}

export function registerReactUpdateQueues(server: McpServer): void {
  server.tool(
    'memlab_react_update_queues',
    'The React eager-bailout leak family as one report. A `useState` update whose eager comparison bails out still leaves its record on `queue.pending`, which then never drains — four separate findings in this workstream have been that same shape, and each round re-derived the same three things by hand. This returns: how many queues hold a pending chain (BREADTH), how long each chain is (LENGTH), and which component owns it. The breadth-vs-length split is the part that decides the finding — a flat queue count with growing records is accumulation in existing queues, which is the leak; a rising queue count with one record each is just more hooks mounted, which is not. Getting that backwards is the difference between a filing and a retraction.',
    {
      max_chain: z
        .number()
        .optional()
        .default(100000)
        .describe(
          'Safety bound on links walked per chain (default 100000). A chain longer than this is itself the finding; the result says it was capped rather than reporting the cap as a length.',
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum components to report (default 20).'),
      max_hops: z
        .number()
        .optional()
        .default(12)
        .describe('Referrer hops allowed when looking for the owning fiber.'),
    },
    async ({max_chain, limit, max_hops}) => {
      try {
        const snapshot = getSnapshot();

        // A queue is recognised by holding a `pending` edge to an update
        // record, rather than by name: `queue` is minified and the hook object
        // it hangs off is a plain Object.
        const queues: IHeapNode[] = [];
        let totalRecords = 0;
        snapshot.nodes.forEach(node => {
          if (node.type !== 'object') return;
          if (isUpdateRecord(node)) totalRecords++;
          for (const edge of node.references) {
            if (edge.type !== 'property') continue;
            if (String(edge.name_or_index) !== 'pending') continue;
            if (isUpdateRecord(edge.toNode)) queues.push(node);
            break;
          }
        });

        if (queues.length === 0) {
          return toolResult(
            'No React update queue in this snapshot holds a pending chain.\n\n' +
              `${formatNumber(totalRecords)} update record(s) exist in total. If that number is large while no queue holds one, the records are retained by something OTHER than a live queue — which is a different (and usually more interesting) finding: trace one with \`memlab_retainer_trace\`.`,
          );
        }

        const reports: QueueReport[] = [];
        for (const queue of queues) {
          let head: IHeapNode | null = null;
          for (const edge of queue.references) {
            if (String(edge.name_or_index) === 'pending') {
              head = edge.toNode;
              break;
            }
          }
          if (head == null) continue;
          const {length, terminated} = chainLength(head, max_chain);
          const fiber = nearestFiber(queue, max_hops);
          reports.push({
            queueId: queue.id,
            component:
              (fiber != null ? fiberComponentName(fiber) : null) ??
              '(unattributed)',
            length,
            terminated,
          });
        }

        interface Bucket {
          component: string;
          queues: number;
          records: number;
          longest: number;
          capped: number;
          example: number;
        }
        const byComponent = new Map<string, Bucket>();
        for (const r of reports) {
          let b = byComponent.get(r.component);
          if (!b) {
            b = {
              component: r.component,
              queues: 0,
              records: 0,
              longest: 0,
              capped: 0,
              example: r.queueId,
            };
            byComponent.set(r.component, b);
          }
          b.queues++;
          b.records += r.length;
          if (r.length > b.longest) {
            b.longest = r.length;
            b.example = r.queueId;
          }
          if (r.terminated === 'cap') b.capped++;
        }

        const ranked = [...byComponent.values()].sort(
          (a, b) => b.records - a.records,
        );
        const shown = ranked.slice(0, limit);
        const pendingRecords = reports.reduce((s, r) => s + r.length, 0);
        const anyCapped = reports.some(r => r.terminated === 'cap');

        const lines: string[] = [
          '## React update queues holding a pending chain',
          '',
          `**Breadth: ${formatNumber(reports.length)} queue(s)** · **Length: ${formatNumber(pendingRecords)} pending record(s)** · ` +
            `${formatNumber(totalRecords)} update record(s) exist in the heap in total.`,
          '',
          markdownTable(
            [
              'Component',
              'Queues',
              'Pending records',
              'Longest chain',
              'Example',
            ],
            shown.map(b => [
              b.component + (b.capped > 0 ? ' ⚠' : ''),
              formatNumber(b.queues),
              formatNumber(b.records),
              formatNumber(b.longest),
              `@${b.example}`,
            ]),
            new Set([1, 2, 3]),
          ),
          '',
        ];
        if (ranked.length > shown.length) {
          lines.push(
            `_${formatNumber(ranked.length - shown.length)} further component(s) not shown; raise \`limit\`._`,
            '',
          );
        }
        if (anyCapped) {
          lines.push(
            `⚠ ${formatNumber(reports.filter(r => r.terminated === 'cap').length)} chain(s) hit the ${formatNumber(max_chain)}-link cap — those lengths are FLOORS, not measurements. Raise \`max_chain\`.`,
            '',
          );
        }

        lines.push(
          '### How to read this across a ladder',
          '',
          '- **Queue count (breadth) FLAT, pending records rising** → existing queues are accumulating. This is the leak shape, and it is what to file.',
          '- **Queue count rising, records-per-queue ~1** → more components are mounted. Not a leak; the population scales with the UI.',
          '- **Both rising** → separate them before concluding, or the write-up will attribute mounting to leaking.',
          '',
          'One measured round found `REPRODUCED` on record count and `NOT_REPRODUCED` on breadth across independent runs, which is exactly what proved the chains were lengthening rather than multiplying.',
        );

        if (!suggestionsSuppressed() && shown.length > 0) {
          lines.push(
            '',
            '**Suggested next steps**',
            `- \`memlab_ladder_probe\` on this tool's two numbers across the rungs — breadth and total pending records, separately.`,
            `- \`memlab_replicate\` before filing: this family has produced a retraction when a single run was trusted.`,
            `- \`memlab_verify_fix({metric_kind: "pending_chain", locator: "<Owner>.<property>"})\` once both arms are driven — no runtime gate needed, it takes two sets of snapshot files.`,
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
