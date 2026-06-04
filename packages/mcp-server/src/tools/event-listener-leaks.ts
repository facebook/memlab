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

interface ContextDistribution {
  uniqueCallbacks: number;
  uniqueContexts: number;
  totalListeners: number;
  contextShapes: Array<{
    shapeName: string;
    count: number;
    exampleId: number;
  }>;
  orphanedContextCount: number;
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
  contextDistribution?: ContextDistribution;
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

function analyzeContextDistribution(
  listeners: ListenerEntry[],
  snapshot: ReturnType<typeof getSnapshot>,
): ContextDistribution {
  const callbackIds = new Set<number>();
  const contextIds = new Set<number>();
  const contextShapeMap = new Map<string, {count: number; exampleId: number}>();
  let orphanedCount = 0;

  for (const l of listeners) {
    callbackIds.add(l.callbackId);
    if (l.contextId != null) {
      contextIds.add(l.contextId);

      const ctxNode = snapshot.getNodeById(l.contextId);
      if (ctxNode) {
        const shapeName = ctxNode.name;
        const existing = contextShapeMap.get(shapeName);
        if (existing) {
          existing.count++;
        } else {
          contextShapeMap.set(shapeName, {count: 1, exampleId: ctxNode.id});
        }

        if (ctxNode.numOfReferrers <= 2) {
          orphanedCount++;
        }
      }
    }
  }

  const contextShapes = [...contextShapeMap.entries()]
    .map(([shapeName, info]) => ({
      shapeName,
      count: info.count,
      exampleId: info.exampleId,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    uniqueCallbacks: callbackIds.size,
    uniqueContexts: contextIds.size,
    totalListeners: listeners.length,
    contextShapes,
    orphanedContextCount: orphanedCount,
  };
}

// A duplicate is the SAME callback function instance bound to the SAME context
// instance, registered more than once. We key by node ids (callbackId +
// contextId), NOT by name/shape — keying by name counted distinct closures that
// merely share a name across different hosts as "duplicates", which produced
// wildly inflated counts (e.g. 99.95%) on per-model registries that are really
// structural, one-listener-per-model (Feedback §8).
function countDuplicateCallbacks(listeners: ListenerEntry[]): number {
  const pairs = new Map<string, number>();
  for (const l of listeners) {
    if (l.callbackId <= 0) continue;
    const key = `${l.callbackId}\0${l.contextId ?? 0}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  let duplicates = 0;
  for (const count of pairs.values()) {
    if (count > 1) duplicates += count - 1;
  }
  return duplicates;
}

export function registerEventListenerLeaks(server: McpServer): void {
  server.tool(
    'memlab_event_listener_leaks',
    'Detect EventEmitter-style listener accumulation — the #1 cause of memory leaks in ' +
      'event-driven apps. Scans for: (1) objects with _events/_listeners properties (Backbone/Node.js), ' +
      'and (2) accumulations of {callback, context}-shaped objects (custom event systems like ' +
      'WAWebEventEmitter, Signal, etc.). Detects arrays with >N entries (accumulation), entries ' +
      'where the context/ctx object has no other referrers (zombie listeners), and multiple entries ' +
      'with the same callback (mount/unmount leaks). ' +
      'Use extra_event_properties to detect app-specific event container property names ' +
      '(e.g., "#eventMap" for private class fields).',
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
      extra_event_properties: z
        .array(z.string())
        .optional()
        .describe(
          'Additional property names to scan as event containers (e.g., ["#eventMap", "#listeningTo"] for private class fields). ' +
            'These are checked in addition to the built-in patterns (_events, _listeners, eventMap, etc.).',
        ),
      detect_shapes: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Also detect accumulations of {callback, context}-shaped objects regardless of parent property naming (default true). ' +
            "Catches custom event systems that don't use standard _events/_listeners patterns.",
        ),
      analyze_contexts: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'For each accumulation, analyze the distribution of unique callbacks vs contexts, ' +
            'group context objects by shape/class, and detect orphaned contexts (default true). ' +
            'This is the key signal for identifying listener-based memory leaks where many ' +
            'orphaned objects register on the same event.',
        ),
    },
    async ({
      min_listeners,
      limit,
      check_zombies,
      extra_event_properties,
      detect_shapes,
      analyze_contexts,
    }) => {
      try {
        const snapshot = getSnapshot();
        const accumulations: EventAccumulation[] = [];

        const effectiveEventProps = new Set(EVENT_PROPERTY_NAMES);
        if (extra_event_properties) {
          for (const p of extra_event_properties) {
            effectiveEventProps.add(p);
          }
        }

        snapshot.nodes.forEach(node => {
          if (node.id <= 3) return;
          if (node.type !== 'object') return;

          for (const edge of node.references) {
            const eName = String(edge.name_or_index);
            if (!effectiveEventProps.has(eName)) continue;
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

            const contextDist = analyze_contexts
              ? analyzeContextDistribution(allListeners, snapshot)
              : undefined;

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
              contextDistribution: contextDist,
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

        // Shape-based detection: find accumulations of {callback, context}-shaped objects
        if (detect_shapes) {
          const CALLBACK_PROPS = new Set([
            'callback',
            'fn',
            'handler',
            'listener',
          ]);
          const CONTEXT_PROPS = new Set([
            'context',
            'ctx',
            'this',
            'target',
            'scope',
          ]);

          const shapeMap = new Map<
            string,
            {
              count: number;
              totalRetained: number;
              properties: string[];
              exampleId: number;
              allListeners: ListenerEntry[];
            }
          >();

          snapshot.nodes.forEach(node => {
            if (node.id <= 3) return;
            if (node.type !== 'object' || node.name !== 'Object') return;

            const propNames: string[] = [];
            let hasCallback = false;
            let hasContext = false;
            let callbackId = 0;
            let callbackName = '';
            let contextId: number | null = null;
            let contextName: string | null = null;

            for (const edge of node.references) {
              if (edge.type !== 'property') continue;
              const pName = String(edge.name_or_index);
              propNames.push(pName);
              if (CALLBACK_PROPS.has(pName)) {
                hasCallback = true;
                callbackId = edge.toNode.id;
                callbackName = edge.toNode.name;
              }
              if (CONTEXT_PROPS.has(pName)) {
                hasContext = true;
                contextId = edge.toNode.id;
                contextName = edge.toNode.name;
              }
            }

            if (!hasCallback || !hasContext) return;
            if (propNames.length === 0 || propNames.length > 10) return;

            propNames.sort();
            const key = propNames.join(',');
            const existing = shapeMap.get(key);
            if (existing) {
              existing.count++;
              existing.totalRetained += node.retainedSize;
              existing.allListeners.push({
                callbackId,
                callbackName,
                contextId,
                contextName,
              });
            } else {
              shapeMap.set(key, {
                count: 1,
                totalRetained: node.retainedSize,
                properties: propNames,
                exampleId: node.id,
                allListeners: [
                  {callbackId, callbackName, contextId, contextName},
                ],
              });
            }
          });

          for (const [, shape] of shapeMap) {
            if (shape.count < min_listeners) continue;

            const contextDist = analyze_contexts
              ? analyzeContextDistribution(shape.allListeners, snapshot)
              : undefined;

            const entry: EventAccumulation = {
              hostNodeId: shape.exampleId,
              hostName: `{${shape.properties.join(', ')}}`,
              hostType: 'shape',
              eventPropertyName: `(${shape.properties.join(', ')})`,
              eventContainerId: shape.exampleId,
              totalListeners: shape.count,
              eventBreakdown: [
                {
                  eventName: '(shape-based)',
                  listenerCount: shape.count,
                  sampleListeners: shape.allListeners.slice(0, 3),
                },
              ],
              zombieCount: 0,
              duplicateCallbackCount: countDuplicateCallbacks(
                shape.allListeners,
              ),
              totalRetainedSize: shape.totalRetained,
              contextDistribution: contextDist,
            };

            let inserted = false;
            for (let i = 0; i < accumulations.length; i++) {
              if (entry.totalListeners > accumulations[i].totalListeners) {
                accumulations.splice(i, 0, entry);
                inserted = true;
                break;
              }
            }
            if (!inserted) accumulations.push(entry);
            if (accumulations.length > limit) accumulations.length = limit;
          }
        }

        if (accumulations.length === 0) {
          return toolResult(
            `No event listener accumulation found with >= ${min_listeners} listeners. ` +
              `Try lowering min_listeners, or check \`memlab_find_by_property\` with property_name="callback", ` +
              `or use \`memlab_shape_histogram\` with sort_by="count" to find high-count shapes.`,
          );
        }

        const lines = [
          `## Event Listener Leak Detection`,
          `Found ${accumulations.length} object(s) with potential listener accumulation`,
          '',
          '_"Duplicates" = the same callback instance bound to the same context, registered more than once (by node id, not by name/shape). One listener per distinct model/host is structural, not a leak._',
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
              `**${formatNumber(a.duplicateCallbackCount)} duplicate callback(s)** — the same callback *instance* bound to the same context registered more than once (classic mount/unmount leak). One listener per distinct model is structural, not a duplicate.`,
            );
            lines.push('');
          }

          if (a.contextDistribution) {
            const cd = a.contextDistribution;
            lines.push('**Context distribution:**');
            lines.push(
              `- ${formatNumber(cd.uniqueCallbacks)} unique callback(s) across ${formatNumber(cd.totalListeners)} listeners`,
            );
            lines.push(
              `- ${formatNumber(cd.uniqueContexts)} unique context object(s) across ${formatNumber(cd.totalListeners)} listeners`,
            );
            if (cd.orphanedContextCount > 0) {
              const orphanPct =
                cd.uniqueContexts > 0
                  ? ` (${((cd.orphanedContextCount / cd.uniqueContexts) * 100).toFixed(0)}%)`
                  : '';
              lines.push(
                `- **${formatNumber(cd.orphanedContextCount)} orphaned context(s)**${orphanPct} — only retained by listener registrations`,
              );
            }
            if (cd.contextShapes.length > 0) {
              lines.push('- Context shapes:');
              for (const cs of cd.contextShapes) {
                lines.push(
                  `  - ${formatNumber(cs.count)}× \`${cs.shapeName}\` (example: @${cs.exampleId})`,
                );
              }
            }
            if (
              cd.uniqueCallbacks <= 3 &&
              cd.uniqueContexts > 10 &&
              cd.orphanedContextCount > cd.uniqueContexts * 0.5
            ) {
              lines.push('');
              lines.push(
                `**⚠ LEAK PATTERN:** Few callbacks (${cd.uniqueCallbacks}) but many orphaned contexts (${formatNumber(cd.orphanedContextCount)}) — ` +
                  `classic listener-based memory leak where orphaned objects register on shared models but are never unregistered.`,
              );
            }
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
