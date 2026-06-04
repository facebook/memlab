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
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
  makeScanBudget,
  ScanTimeoutError,
} from '../utils.js';

const CALLBACK_PROPS = new Set(['callback', 'fn', 'handler', 'listener']);
const CONTEXT_PROPS = new Set(['context', 'ctx', 'this', 'target', 'scope']);

interface Listener {
  callbackId: number;
  contextId: number;
}

// Extract {callback, context} listeners (or bare closures) from an Array node.
function listenersFromArray(arr: IHeapNode): Listener[] {
  const out: Listener[] = [];
  for (const e of arr.references) {
    if (e.type !== 'element') continue;
    const entry = e.toNode;
    if (entry.id <= 3) continue;
    if (entry.type === 'closure') {
      out.push({callbackId: entry.id, contextId: 0});
    } else if (entry.type === 'object') {
      let cb = 0;
      let ctx = 0;
      for (const pe of entry.references) {
        const pn = String(pe.name_or_index);
        if (CALLBACK_PROPS.has(pn)) cb = pe.toNode.id;
        else if (CONTEXT_PROPS.has(pn)) ctx = pe.toNode.id;
      }
      if (cb > 0) out.push({callbackId: cb, contextId: ctx});
    }
  }
  return out;
}

export function registerEventRegistry(server: McpServer): void {
  server.tool(
    'memlab_event_registry',
    'Detector for per-model event registries (Backbone/Marionette/observer style): objects mapping event names to arrays of {callback, context} listeners, e.g. `{"change:name": [{callback, context}], "add": [...]}`. Reports top event names by total listener count, the listeners-per-host distribution, and a structural-vs-leak verdict (one listener per host = O(hosts) structural baseline; the same callback instance bound to the same host/event more than once = a re-subscription leak). Complements memlab_event_listener_leaks by understanding the registry structure across many hosts.',
    {
      min_events: z
        .number()
        .optional()
        .default(2)
        .describe(
          'Minimum number of event-name->listener-array properties for an object to count as a registry container (default 2).',
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of event names to report (default 20).'),
      timeout_ms: z
        .number()
        .optional()
        .default(45000)
        .describe(
          'Wall-clock scan budget (default 45000); returns partial results on very large browser heaps instead of hanging.',
        ),
    },
    async ({min_events, limit, timeout_ms}) => {
      try {
        const snapshot = getSnapshot();
        const budget = makeScanBudget(timeout_ms);
        let timedOut = false;

        // Per event-name aggregates across ALL registry containers.
        const perEvent = new Map<
          string,
          {
            totalListeners: number;
            hosts: number;
            duplicatePairs: number; // same callback+context registered >1× on one host/event
          }
        >();
        let containerCount = 0;
        const perHostTotals: number[] = [];
        let totalListenersAll = 0;
        let totalDuplicateExtra = 0;

        try {
          snapshot.nodes.forEach(node => {
            budget.tick();
            if (node.id <= 3 || node.type !== 'object') return;

            // A registry container has >= min_events properties whose target is
            // an Array of listeners.
            let eventProps = 0;
            let hostListeners = 0;
            const localEvents: Array<{name: string; listeners: Listener[]}> =
              [];
            for (const edge of node.references) {
              if (edge.type !== 'property') continue;
              const target = edge.toNode;
              if (target.type !== 'object' || target.name !== 'Array') continue;
              const listeners = listenersFromArray(target);
              if (listeners.length === 0) continue;
              eventProps++;
              hostListeners += listeners.length;
              localEvents.push({
                name: String(edge.name_or_index),
                listeners,
              });
            }
            if (eventProps < min_events) return;

            containerCount++;
            perHostTotals.push(hostListeners);
            totalListenersAll += hostListeners;

            for (const ev of localEvents) {
              const e = perEvent.get(ev.name) ?? {
                totalListeners: 0,
                hosts: 0,
                duplicatePairs: 0,
              };
              e.totalListeners += ev.listeners.length;
              e.hosts++;
              // Duplicates WITHIN this host/event = same callback+context twice.
              const seen = new Map<string, number>();
              for (const l of ev.listeners) {
                const key = `${l.callbackId}\0${l.contextId}`;
                seen.set(key, (seen.get(key) ?? 0) + 1);
              }
              for (const c of seen.values()) {
                if (c > 1) {
                  e.duplicatePairs += c - 1;
                  totalDuplicateExtra += c - 1;
                }
              }
              perEvent.set(ev.name, e);
            }
          });
        } catch (e) {
          if (e instanceof ScanTimeoutError) timedOut = true;
          else throw e;
        }

        if (containerCount === 0) {
          return toolResult(
            `No per-model event registries found (objects with >= ${min_events} event-name -> listener-array properties).` +
              (timedOut ? ' (scan timed out before completing)' : '') +
              ' Try memlab_event_listener_leaks for _events/_listeners-style containers.',
          );
        }

        perHostTotals.sort((a, b) => a - b);
        const median = perHostTotals[Math.floor(perHostTotals.length / 2)];
        const maxPerHost = perHostTotals[perHostTotals.length - 1];
        const avgPerHost = totalListenersAll / containerCount;

        const topEvents = [...perEvent.entries()]
          .sort((a, b) => b[1].totalListeners - a[1].totalListeners)
          .slice(0, limit);

        // Structural vs leak: if duplicates are rare relative to total, the
        // accumulation is O(hosts) structural (one listener per host/event);
        // many duplicates => real re-subscription leak.
        const dupRatio =
          totalListenersAll > 0 ? totalDuplicateExtra / totalListenersAll : 0;
        const verdict =
          totalDuplicateExtra === 0
            ? '**Structural (not a leak):** every listener is a distinct callback/context on its host — this is the expected O(hosts) baseline (one listener per model per event).'
            : dupRatio < 0.01
              ? `**Mostly structural:** ${formatNumber(totalDuplicateExtra)} duplicate registration(s) (${(dupRatio * 100).toFixed(2)}%) — small re-subscription effect, likely benign.`
              : `**⚠ Re-subscription leak:** ${formatNumber(totalDuplicateExtra)} duplicate registration(s) (${(dupRatio * 100).toFixed(1)}%) — the same callback instance is bound to the same host/event repeatedly (missing \`.off()\`/unsubscribe).`;

        const lines: string[] = [
          '## Event Registry Analysis',
          '',
          `${formatNumber(containerCount)} registry host(s), ${formatNumber(totalListenersAll)} total listeners.`,
          `Listeners per host: avg ${avgPerHost.toFixed(1)}, median ${formatNumber(median)}, max ${formatNumber(maxPerHost)}.`,
          '',
          verdict,
          '',
          '### Top event names by total listeners',
          '',
        ];
        const headers = ['Event', 'Total listeners', 'Hosts', 'Duplicates'];
        const rightCols = new Set([1, 2, 3]);
        const rows = topEvents.map(([name, e]) => [
          name.length > 40 ? name.slice(0, 37) + '…' : name,
          formatNumber(e.totalListeners),
          formatNumber(e.hosts),
          formatNumber(e.duplicatePairs),
        ]);
        lines.push(markdownTable(headers, rows, rightCols));
        if (timedOut) {
          lines.push(
            '',
            `⚠ Scan hit the ${timeout_ms}ms budget — results are partial. Raise timeout_ms for full coverage.`,
          );
        }
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
