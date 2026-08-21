/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * Pending async work — scheduler tasks, timer callbacks and unsettled promises —
 * as one census.
 *
 * These are grouped because they are one question ("what work is queued, and
 * what is it holding alive?") and because each half was hand-rolled during real
 * hunts, more than once, with different definitions each time.
 *
 * The scheduler half found a real defect that no existing tool reports. React's
 * scheduler keeps its pending work in an ARRAY-BASED MIN-HEAP, and
 * `unstable_cancelCallback` cannot remove an arbitrary node from one — it sets
 * `task.callback = null` and leaves the record in place, to be discarded only
 * when it reaches the root. With a delayed-task queue ordered by `startTime`, a
 * single long-delay task at the root blocks every dead record behind it.
 * Measured on one app: 88 -> 650 tasks over 200 interactions with 65% of them
 * already cancelled, and 1,212 tasks at 44% cancelled on another surface.
 *
 * A cancelled-share above a quarter is the signal; the absolute count is not,
 * because a healthy queue is also allowed to be long.
 */

/** React scheduler task record. */
const SCHEDULER_TASK_PROPS = [
  'callback',
  'expirationTime',
  'priorityLevel',
  'sortIndex',
  'startTime',
];

const CANCELLED_SHARE_WARN = 0.25;

function shapeKeys(node: IHeapNode): Set<string> {
  const out = new Set<string>();
  for (const edge of node.references) {
    if (edge.type !== 'property') continue;
    const n = String(edge.name_or_index);
    if (n === '__proto__') continue;
    out.add(n);
  }
  return out;
}

function propTarget(node: IHeapNode, name: string): IHeapNode | null {
  for (const edge of node.references) {
    if (edge.type !== 'property') continue;
    if (String(edge.name_or_index) !== name) continue;
    return edge.toNode ?? null;
  }
  return null;
}

/** A scheduler task is cancelled when its callback slot holds null/undefined. */
function isCancelledTask(node: IHeapNode): boolean {
  const cb = propTarget(node, 'callback');
  if (cb == null) return true;
  const n = cb.name;
  return n === 'null' || n === 'undefined' || n === 'system / Oddball';
}

export function registerAsyncCensus(server: McpServer): void {
  server.tool(
    'memlab_async_census',
    'Census PENDING ASYNC WORK: React-scheduler task queues (with a live-vs-cancelled split), timer callback closures, and unsettled Promises with their owner shapes. ' +
      "Timer and scheduler accumulation is a common cross-app leak family with no dedicated tool — it was hand-rolled during hunts, differently each time. The scheduler split in particular finds a defect nothing else reports: React's scheduler queues are ARRAY-BASED MIN-HEAPS, so `cancelCallback` only nulls the callback and the dead record stays until it reaches the root; a long-delay task at the root blocks everything behind it. Measured: 88 -> 650 tasks over 200 interactions, 65% already cancelled. " +
      'A cancelled share above 25% is the signal; a long queue on its own is not.',
    {
      limit: z
        .number()
        .optional()
        .default(15)
        .describe('Maximum rows per section (default 15).'),
      min_count: z
        .number()
        .optional()
        .default(10)
        .describe('Ignore groups smaller than this (default 10).'),
    },
    async ({limit, min_count}) => {
      try {
        const snapshot = getSnapshot();
        if (!snapshot) {
          return errorResult(
            'No heap snapshot loaded. Use memlab_load_snapshot first.',
          );
        }

        let tasksLive = 0;
        let tasksCancelled = 0;
        // Queue array id -> counts, so the actual container is nameable.
        const queues = new Map<
          number,
          {live: number; cancelled: number; slots: number}
        >();
        let promisesPending = 0;
        let promisesSettled = 0;
        const promiseOwners = new Map<string, number>();
        const timerClosures = new Map<string, number>();

        snapshot.nodes.forEach((node: IHeapNode) => {
          if (node.id <= 3) return;

          if (node.name === 'Promise' && node.type === 'object') {
            // An unsettled promise still points at its reaction list; a settled
            // one points at the result value.
            let pending = false;
            for (const edge of node.references) {
              const t = edge.toNode;
              if (t != null && t.name === 'system / PromiseReaction') {
                pending = true;
                break;
              }
            }
            if (pending) promisesPending++;
            else promisesSettled++;
            if (pending) {
              for (const edge of node.referrers) {
                const from = edge.fromNode;
                if (from == null || from.id <= 3) continue;
                if (String(edge.name_or_index) === '__proto__') continue;
                const keys = [...shapeKeys(from)].sort();
                if (keys.length === 0) continue;
                const sig = `{${keys.slice(0, 6).join(', ')}}`;
                promiseOwners.set(sig, (promiseOwners.get(sig) ?? 0) + 1);
                break;
              }
            }
            return;
          }

          if (node.type === 'object' && node.name === 'Object') {
            const keys = shapeKeys(node);
            let isTask = true;
            for (const p of SCHEDULER_TASK_PROPS) {
              if (!keys.has(p)) {
                isTask = false;
                break;
              }
            }
            if (isTask) {
              const cancelled = isCancelledTask(node);
              if (cancelled) tasksCancelled++;
              else tasksLive++;
              for (const edge of node.referrers) {
                const from = edge.fromNode;
                if (from == null || from.name !== 'Array') continue;
                const q = queues.get(from.id) ?? {
                  live: 0,
                  cancelled: 0,
                  slots: from.edge_count,
                };
                if (cancelled) q.cancelled++;
                else q.live++;
                queues.set(from.id, q);
                break;
              }
            }
            return;
          }

          // Timer callbacks: closures held by a scheduler/timeout wrapper.
          if (node.type === 'closure') {
            const n = node.name;
            if (
              n.startsWith('setTimeout') ||
              n.startsWith('setInterval') ||
              n.includes('scheduleDelayedCallback') ||
              n.includes('requestIdleCallback')
            ) {
              timerClosures.set(n, (timerClosures.get(n) ?? 0) + 1);
            }
          }
        });

        const lines: string[] = ['## Pending async work', ''];

        const tasksTotal = tasksLive + tasksCancelled;
        if (tasksTotal > 0) {
          const share = tasksCancelled / tasksTotal;
          lines.push(
            '### Scheduler task queues',
            '',
            `**${formatNumber(tasksTotal)} scheduler task record(s)** — ${formatNumber(tasksLive)} live, **${formatNumber(tasksCancelled)} cancelled (${(share * 100).toFixed(0)}%)**.`,
          );
          if (share >= CANCELLED_SHARE_WARN) {
            lines.push(
              '',
              `⚠ More than ${(CANCELLED_SHARE_WARN * 100).toFixed(0)}% of the queue is dead records. React's scheduler uses an array-based min-heap, so a cancelled task is only nulled — it is discarded when it reaches the ROOT of the heap, and a long-delay task sitting at the root blocks everything behind it. This costs O(n) heap operations per schedule and holds the records' memory until the queue drains.`,
            );
          }
          const qRows = [...queues.entries()]
            .sort(
              (a, b) =>
                b[1].live + b[1].cancelled - (a[1].live + a[1].cancelled),
            )
            .slice(0, limit)
            .filter(([, q]) => q.live + q.cancelled >= min_count);
          if (qRows.length > 0) {
            lines.push(
              '',
              markdownTable(
                [
                  'Queue',
                  'Tasks',
                  'Live',
                  'Cancelled',
                  '% dead',
                  'Array slots',
                ],
                qRows.map(([id, q]) => [
                  `@${id}`,
                  formatNumber(q.live + q.cancelled),
                  formatNumber(q.live),
                  formatNumber(q.cancelled),
                  `${((q.cancelled / Math.max(1, q.live + q.cancelled)) * 100).toFixed(0)}%`,
                  formatNumber(q.slots),
                ]),
                new Set([1, 2, 3, 4, 5]),
              ),
              '',
              '_`memlab_retainer_trace` a queue id to name the module that owns it — the strong retainer is usually a single closure `context` edge, with the rest weak._',
            );
          }
          lines.push('');
        }

        if (timerClosures.size > 0) {
          const rows = [...timerClosures.entries()]
            .filter(([, c]) => c >= min_count)
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit);
          if (rows.length > 0) {
            lines.push(
              '### Timer / delayed-callback closures',
              '',
              markdownTable(
                ['Closure', 'Count'],
                rows.map(([n, c]) => [n, formatNumber(c)]),
                new Set([1]),
              ),
              '',
            );
          }
        }

        const pTotal = promisesPending + promisesSettled;
        if (pTotal > 0) {
          lines.push(
            '### Promises',
            '',
            `**${formatNumber(pTotal)} Promise(s)** — **${formatNumber(promisesPending)} UNSETTLED** (reaction list attached, no result), ${formatNumber(promisesSettled)} settled.`,
          );
          const owners = [...promiseOwners.entries()]
            .filter(([, c]) => c >= min_count)
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit);
          if (owners.length > 0) {
            lines.push(
              '',
              'Owner shapes holding an unsettled promise:',
              markdownTable(
                ['Owner shape', 'Count'],
                owners.map(([s, c]) => [s, formatNumber(c)]),
                new Set([1]),
              ),
              '',
              '_An owner shaped `{abort, promise}` accumulating is the signature of abortable operations whose promises never settle — a robustness smell as much as a memory one. Promises are individually small, so check the aggregate retained (`memlab_eval` + `helpers.aggregateRetained`) before ranking this against a byte-sized finding._',
            );
          }
          lines.push('');
        }

        if (tasksTotal === 0 && pTotal === 0 && timerClosures.size === 0) {
          lines.push(
            '_No scheduler tasks, timer closures or promises found. That is a genuine negative for this family; it does not cover `requestAnimationFrame` callbacks or native timers with no JS-visible record._',
          );
        }
        lines.push(
          '_Counts are per-snapshot. Whether a queue is DRAINING or ACCUMULATING needs a ladder — run this on two rungs, or track the queue with `memlab_collection_trend` once you have named its owner._',
        );
        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(
          `Failed to census async work: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
