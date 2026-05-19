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
  formatBytes,
  formatNumber,
  markdownTable,
  truncateNodeName,
  errorResult,
  toolResult,
} from '../utils.js';

const EVENT_PROPERTY_NAMES = new Set([
  '_events',
  '_listeners',
  'eventMap',
  '__events',
  '_eventHandlers',
  'listeners',
  '__listeners',
]);

interface ListenerEntry {
  callbackId: number;
  callbackName: string;
  contextId: number | null;
  contextName: string | null;
}

interface EventAccumulation {
  hostNodeId: number;
  hostName: string;
  hostType: string;
  eventPropertyName: string;
  eventContainerId: number;
  totalListeners: number;
  eventBreakdown: Array<{
    eventName: string;
    listenerCount: number;
    sampleListeners: ListenerEntry[];
  }>;
  zombieCount: number;
  duplicateCallbackCount: number;
  totalRetainedSize: number;
}

function inspectEventContainer(
  container: IHeapNode,
): Array<{eventName: string; listeners: ListenerEntry[]}> {
  const events: Array<{eventName: string; listeners: ListenerEntry[]}> = [];

  for (const edge of container.references) {
    const eventName = String(edge.name_or_index);
    if (edge.toNode.type === 'hidden' || edge.toNode.id <= 3) continue;

    const listeners: ListenerEntry[] = [];

    if (edge.toNode.type === 'object' && edge.toNode.name === 'Array') {
      for (const arrEdge of edge.toNode.references) {
        if (arrEdge.type !== 'element') continue;
        const entry = arrEdge.toNode;
        if (entry.id <= 3) continue;

        if (entry.type === 'closure') {
          listeners.push({
            callbackId: entry.id,
            callbackName: entry.name,
            contextId: null,
            contextName: null,
          });
        } else if (entry.type === 'object') {
          let callbackId = 0;
          let callbackName = '';
          let contextId: number | null = null;
          let contextName: string | null = null;

          for (const propEdge of entry.references) {
            const pName = String(propEdge.name_or_index);
            if (
              pName === 'callback' ||
              pName === 'fn' ||
              pName === 'handler' ||
              pName === 'listener'
            ) {
              callbackId = propEdge.toNode.id;
              callbackName = propEdge.toNode.name;
            }
            if (
              pName === 'context' ||
              pName === 'ctx' ||
              pName === 'this' ||
              pName === 'target'
            ) {
              contextId = propEdge.toNode.id;
              contextName = propEdge.toNode.name;
            }
          }
          if (callbackId > 0) {
            listeners.push({
              callbackId,
              callbackName,
              contextId,
              contextName,
            });
          }
        }
      }
    } else if (edge.toNode.type === 'closure') {
      listeners.push({
        callbackId: edge.toNode.id,
        callbackName: edge.toNode.name,
        contextId: null,
        contextName: null,
      });
    }

    if (listeners.length > 0) {
      events.push({eventName, listeners});
    }
  }

  return events;
}

function countZombies(
  listeners: ListenerEntry[],
  snapshot: ReturnType<typeof getSnapshot>,
): number {
  let zombies = 0;
  for (const l of listeners) {
    if (l.contextId == null) continue;
    const ctxNode = snapshot.getNodeById(l.contextId);
    if (!ctxNode) continue;
    if (ctxNode.numOfReferrers <= 2) {
      zombies++;
    }
  }
  return zombies;
}

function countDuplicateCallbacks(listeners: ListenerEntry[]): number {
  const callbackContextPairs = new Map<string, number>();
  for (const l of listeners) {
    const key = `${l.callbackName}\0${l.contextName ?? ''}`;
    callbackContextPairs.set(key, (callbackContextPairs.get(key) ?? 0) + 1);
  }
  let duplicates = 0;
  for (const count of callbackContextPairs.values()) {
    if (count > 1) duplicates += count - 1;
  }
  return duplicates;
}

export function registerEventListenerLeaks(server: McpServer): void {
  server.tool(
    'memlab_event_listener_leaks',
    'Detect EventEmitter-style listener accumulation — the #1 cause of memory leaks in ' +
      'Backbone/Node.js/EventEmitter-based apps. Scans for objects with _events/_listeners ' +
      'properties and flags: arrays with >N entries (accumulation), entries where the ' +
      'context/ctx object has no other referrers (zombie listeners from missed .off() calls), ' +
      'and multiple entries with the same callback but different contexts (mount/unmount leaks). ' +
      'Use after memlab_auto_investigate flags subscription accumulation.',
    {
      min_listeners: z
        .number()
        .optional()
        .default(50)
        .describe(
          'Minimum total listener count on a single host to report (default 50)',
        ),
      limit: z
        .number()
        .optional()
        .default(15)
        .describe('Maximum number of hosts to return (default 15)'),
      check_zombies: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Check for zombie listeners whose context objects have no other referrers (default true). Can be slow on very large snapshots.',
        ),
    },
    async ({min_listeners, limit, check_zombies}) => {
      try {
        const snapshot = getSnapshot();
        const accumulations: EventAccumulation[] = [];

        snapshot.nodes.forEach(node => {
          if (node.id <= 3) return;
          if (node.type !== 'object') return;

          for (const edge of node.references) {
            const eName = String(edge.name_or_index);
            if (!EVENT_PROPERTY_NAMES.has(eName)) continue;
            if (edge.toNode.id <= 3) continue;

            const events = inspectEventContainer(edge.toNode);
            const totalListeners = events.reduce(
              (s, e) => s + e.listeners.length,
              0,
            );
            if (totalListeners < min_listeners) continue;

            const allListeners = events.flatMap(e => e.listeners);
            const zombieCount = check_zombies
              ? countZombies(allListeners, snapshot)
              : 0;
            const duplicateCallbackCount =
              countDuplicateCallbacks(allListeners);

            const entry: EventAccumulation = {
              hostNodeId: node.id,
              hostName: node.name,
              hostType: node.type,
              eventPropertyName: eName,
              eventContainerId: edge.toNode.id,
              totalListeners,
              eventBreakdown: events
                .sort((a, b) => b.listeners.length - a.listeners.length)
                .slice(0, 10)
                .map(e => ({
                  eventName: e.eventName,
                  listenerCount: e.listeners.length,
                  sampleListeners: e.listeners.slice(0, 3),
                })),
              zombieCount,
              duplicateCallbackCount,
              totalRetainedSize: node.retainedSize,
            };

            let inserted = false;
            for (let i = 0; i < accumulations.length; i++) {
              if (totalListeners > accumulations[i].totalListeners) {
                accumulations.splice(i, 0, entry);
                inserted = true;
                break;
              }
            }
            if (!inserted) accumulations.push(entry);
            if (accumulations.length > limit) accumulations.length = limit;
            break;
          }
        });

        if (accumulations.length === 0) {
          return toolResult(
            `No event listener accumulation found with >= ${min_listeners} listeners. ` +
              `Try lowering min_listeners or check \`memlab_find_by_property\` with property_name="_events".`,
          );
        }

        const lines = [
          `## Event Listener Leak Detection`,
          `Found ${accumulations.length} object(s) with potential listener accumulation`,
          '',
        ];

        const headers = [
          'Host',
          'Class',
          'Property',
          'Listeners',
          'Zombies',
          'Duplicates',
          'Retained',
        ];
        const rightCols = new Set([3, 4, 5, 6]);
        const rows = accumulations.map(a => [
          `@${a.hostNodeId}`,
          truncateNodeName(a.hostName, a.hostType, 0, 30),
          a.eventPropertyName,
          formatNumber(a.totalListeners),
          check_zombies ? formatNumber(a.zombieCount) : '-',
          formatNumber(a.duplicateCallbackCount),
          formatBytes(a.totalRetainedSize),
        ]);

        lines.push(markdownTable(headers, rows, rightCols));
        lines.push('');

        for (const a of accumulations.slice(0, 5)) {
          lines.push(
            `### @${a.hostNodeId} \`${truncateNodeName(a.hostName, a.hostType, 0, 40)}\` — ${formatNumber(a.totalListeners)} listeners`,
          );
          lines.push('');

          if (a.zombieCount > 0) {
            lines.push(
              `**${formatNumber(a.zombieCount)} zombie listener(s)** — context objects with no other referrers (likely from missing \`.off()\` calls)`,
            );
            lines.push('');
          }
          if (a.duplicateCallbackCount > 0) {
            lines.push(
              `**${formatNumber(a.duplicateCallbackCount)} duplicate callback(s)** — same callback registered multiple times (classic mount/unmount leak)`,
            );
            lines.push('');
          }

          lines.push('Event breakdown:');
          for (const ev of a.eventBreakdown) {
            lines.push(
              `- \`${ev.eventName}\`: ${formatNumber(ev.listenerCount)} listener(s)`,
            );
            for (const l of ev.sampleListeners) {
              const ctx = l.contextName
                ? `, context: \`${l.contextName}\` @${l.contextId}`
                : '';
              lines.push(
                `  - callback: \`${l.callbackName}\` @${l.callbackId}${ctx}`,
              );
            }
          }
          lines.push('');
        }

        lines.push('**Suggested next steps:**');
        const top = accumulations[0];
        lines.push(
          `- Inspect host: \`memlab_object_shape(${top.hostNodeId})\``,
        );
        lines.push(
          `- Trace retention: \`memlab_retainer_trace(${top.hostNodeId})\``,
        );
        lines.push(
          `- Inspect event container: \`memlab_get_references(${top.eventContainerId})\``,
        );
        if (top.zombieCount > 0) {
          lines.push(
            `- Find zombie contexts: use \`memlab_referrer_summary(${top.eventContainerId})\` to identify which context classes dominate`,
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
