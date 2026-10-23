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
import {getSnapshot} from '../heap-state.js';
import {cachedPathLabeler} from '../heap-families.js';
import {sourceOfNode} from './module-attribution.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

const TASK_SHAPE = [
  'callback',
  'priorityLevel',
  'startTime',
  'expirationTime',
  'sortIndex',
];

function hasProps(node: IHeapNode, props: ReadonlyArray<string>): boolean {
  const names = new Set<string>();
  for (const e of node.references) {
    if (e.type === 'property') names.add(String(e.name_or_index));
  }
  return props.every(p => names.has(p));
}

/** Closure-valued and object-valued variables of a function's own context. */
function contextVars(fn: IHeapNode): {fns: IHeapNode[]; objs: IHeapNode[]} {
  const fns: IHeapNode[] = [];
  const objs: IHeapNode[] = [];
  const ctx = fn.getReferenceNode('context');
  if (ctx == null) return {fns, objs};
  for (const e of ctx.references) {
    if (e.type !== 'context') continue;
    const t = e.toNode;
    if (t.type === 'closure') fns.push(t);
    else if (t.type === 'object' || t.type === 'array') objs.push(t);
  }
  return {fns, objs};
}

/**
 * The function a scheduled callback really runs. Error guards and time-slice
 * wrappers close over the wrapped function, so descend through closure-valued
 * context variables while the current function is a thin wrapper.
 */
function unwrap(fn: IHeapNode): {inner: IHeapNode; depth: number} {
  let cur = fn;
  for (let depth = 0; depth < 4; depth++) {
    const guarded = cur.getReferenceNode('__isMetaErrorGuarded') != null;
    const {fns, objs} = contextVars(cur);
    const next = fns.find(f => f.id !== cur.id);
    if (next == null) return {inner: cur, depth};
    // A wrapper captures the wrapped function and little else.
    if (!guarded && objs.length > 2) return {inner: cur, depth};
    cur = next;
  }
  return {inner: cur, depth: 4};
}

// Module registries and globals are reachable from every module-level
// closure; reporting one as a timer's "payload" would blame the timer for the
// whole app.
function isAmbient(node: IHeapNode): boolean {
  if (node.name.startsWith('Window') || node.name.startsWith('system /')) {
    return true;
  }
  if (node.edge_count < 1000) return false;
  let props = 0;
  for (const e of node.references) if (e.type === 'property') props++;
  return props >= 1000;
}

/** The biggest object a function (or the functions it closes over) captures. */
function payloadOf(fn: IHeapNode): IHeapNode | null {
  let best: IHeapNode | null = null;
  const visit = (f: IHeapNode, depth: number): void => {
    const {fns, objs} = contextVars(f);
    for (const o of objs) {
      if (isAmbient(o)) continue;
      if (best == null || o.retainedSize > best.retainedSize) best = o;
    }
    if (depth < 2) for (const g of fns) visit(g, depth + 1);
  };
  visit(fn, 0);
  return best;
}

function shapeOf(node: IHeapNode): string {
  const keys: string[] = [];
  for (const e of node.references) {
    if (e.type !== 'property') continue;
    const k = String(e.name_or_index);
    if (k === '__proto__') continue;
    keys.push(k);
    if (keys.length >= 5) break;
  }
  return keys.length > 0 ? `{${keys.join(', ')}}` : node.name;
}

interface TimerGroup {
  fnName: string;
  module: string;
  payloadShape: string;
  payloadOwner: string;
  tasks: number[];
  payloads: Set<number>;
  sharedPayloads: number;
}

export function registerTimers(server: McpServer): void {
  server.tool(
    'memlab_timers',
    'Pending timers and scheduled tasks, grouped by the function they will run and what that function CAPTURES. Finds React Scheduler task records by shape (`{callback, priorityLevel, startTime, expirationTime, sortIndex}` — what `setTimeout` lands in on apps that route timers through the scheduler), unwraps error-guard / time-slice wrappers down to the real callback, and for each group reports the task count, the module, the largest captured payload (its shape and its shortest-path owner) and how many of those payloads are ALSO held elsewhere. ' +
      "A timer that captures a record keeps it alive until it fires; one per record (an expiry timer per traced interaction, say) retains the whole population for the timer's delay, even after its owning map lets go. Cancelled tasks (null callback) still occupying the queue are counted separately.",
    {
      limit: z
        .number()
        .int()
        .optional()
        .default(15)
        .describe('Groups to show (default 15).'),
    },
    async ({limit}) => {
      try {
        const snapshot: IHeapSnapshot = getSnapshot();
        const labeler = cachedPathLabeler(snapshot);
        const tasks: IHeapNode[] = [];
        snapshot.nodes.forEach((n: IHeapNode) => {
          if (n.type === 'object' && hasProps(n, TASK_SHAPE)) tasks.push(n);
        });
        if (tasks.length === 0) {
          return toolResult(
            'No scheduler task records found (`{callback, priorityLevel, startTime, expirationTime, sortIndex}`). This app may not route timers through a scheduler; native browser timers are not visible in a heap snapshot.',
          );
        }
        let cancelled = 0;
        const groups = new Map<string, TimerGroup>();
        for (const t of tasks) {
          const cb = t.getReferenceNode('callback');
          if (cb == null || cb.type !== 'closure') {
            cancelled++;
            continue;
          }
          const {inner} = unwrap(cb);
          const shared = inner.getReferenceNode('shared');
          const payload = payloadOf(inner);
          const mod = sourceOfNode(snapshot, inner).module ?? '?';
          const pShape = payload != null ? shapeOf(payload) : '—';
          const key = `${shared?.id ?? inner.name}|${mod}|${pShape}`;
          let g = groups.get(key);
          if (g == null) {
            g = {
              fnName: inner.name || '(anonymous)',
              module: mod,
              payloadShape: pShape,
              payloadOwner: payload != null ? labeler.labelOf(payload) : '—',
              tasks: [],
              payloads: new Set(),
              sharedPayloads: 0,
            };
            groups.set(key, g);
          }
          g.tasks.push(t.id);
          if (payload != null && !g.payloads.has(payload.id)) {
            g.payloads.add(payload.id);
            // Held elsewhere = more than the one closure context referencing it.
            let holders = 0;
            for (const e of payload.referrers) {
              if (e.type !== 'weak' && e.type !== 'shortcut') holders++;
            }
            if (holders > 1) g.sharedPayloads++;
          }
        }
        const rows = [...groups.values()]
          .map(g => ({
            g,
            retained: [...g.payloads].reduce(
              (s, id) => s + (snapshot.getNodeById(id)?.retainedSize ?? 0),
              0,
            ),
          }))
          .sort((a, b) => b.g.tasks.length - a.g.tasks.length)
          .slice(0, limit);
        // On a minified build module scopes rarely resolve; drop the column
        // rather than print a column of "?".
        const showModule = rows.some(r => r.g.module !== '?');
        const header = [
          'Tasks',
          'Function',
          ...(showModule ? ['Module'] : []),
          'Captured payload',
          'Payload owner (shortest path)',
          'Payloads also held elsewhere',
          'Payload retained',
        ];
        return toolResult(
          [
            `## Scheduled tasks — ${formatNumber(tasks.length)} task record(s), ${formatNumber(cancelled)} cancelled (null callback, still queued)`,
            '',
            markdownTable(
              header,
              rows.map(({g, retained}) => [
                formatNumber(g.tasks.length),
                g.fnName,
                ...(showModule ? [g.module] : []),
                g.payloadShape.length > 60
                  ? `${g.payloadShape.slice(0, 57)}…`
                  : g.payloadShape,
                g.payloadOwner,
                `${formatNumber(g.sharedPayloads)} / ${formatNumber(g.payloads.size)}`,
                formatBytes(retained),
              ]),
              new Set([0, header.length - 2, header.length - 1]),
            ),
            '',
            '_**Payload retained** is the dominator-retained size of the distinct payloads, so bytes ALSO held by their owner (the "also held elsewhere" column) are not freed by cancelling the timer alone — but the timer keeps them alive for its whole delay after the owner lets go._',
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
