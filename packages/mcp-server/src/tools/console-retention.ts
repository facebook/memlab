/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapEdge, IHeapNode, IHeapSnapshot} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {tickAnalysis} from '../analysis-budget.js';
import {getSnapshot, getSnapshotByHandle} from '../heap-state.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';
import {
  collectDevRoots,
  computeReachableWithoutDevRoots,
  type DevRoots,
} from './dev-artifacts.js';

/** Own property names, used only to make a logged plain object identifiable. */
function ownPropertyNames(node: IHeapNode, max: number): string[] {
  const names: string[] = [];
  node.forEachReference((edge: IHeapEdge) => {
    if (names.length >= max) return;
    if (edge.type !== 'property') return;
    const name = String(edge.name_or_index);
    if (name === '__proto__') return;
    names.push(name);
  });
  return names;
}

interface HeldKind {
  label: string;
  count: number;
  selfBytes: number;
  sampleId: number;
}

/** Keep only the console roots, so the question asked is about the console alone. */
function consoleOnlyRoots(devRoots: DevRoots): DevRoots {
  const byId = new Map<number, string>();
  const categoryById = new Map<number, 'console'>();
  for (const [id, category] of devRoots.categoryById) {
    if (category !== 'console') continue;
    const name = devRoots.byId.get(id);
    if (name == null) continue;
    byId.set(id, name);
    categoryById.set(id, 'console');
  }
  return {byId, categoryById} as DevRoots;
}

/**
 * What the attached console is holding, grouped so the output names the LOG
 * CALL to silence rather than listing a thousand ids.
 */
function inventory(snapshot: IHeapSnapshot, devRoots: DevRoots): HeldKind[] {
  const kinds = new Map<string, HeldKind>();
  // `collectDevRoots` records the console-HELD OBJECT as the root — the global
  // handle itself is not a node with a stable identity — so these ids are the
  // logged objects, not the handles pointing at them.
  for (const [heldId] of devRoots.byId) {
    tickAnalysis();
    const held = snapshot.getNodeById(heldId);
    if (held == null) continue;
    let label = held.name;
    if (held.isString) {
      label = `"${held.name.slice(0, 46)}${held.name.length > 46 ? '…' : ''}" (string)`;
    } else if (held.type === 'object') {
      const keys = ownPropertyNames(held, 6);
      if (keys.length > 0) label = `${held.name} {${keys.join(', ')}}`;
    }
    const existing = kinds.get(label);
    if (existing != null) {
      existing.count++;
      existing.selfBytes += held.self_size;
      continue;
    }
    kinds.set(label, {
      label,
      count: 1,
      selfBytes: held.self_size,
      sampleId: held.id,
    });
  }
  return [...kinds.values()].sort((a, b) => b.count - a.count);
}

export function registerConsoleRetention(server: McpServer): void {
  server.tool(
    'memlab_console_retention',
    'Report what an attached DevTools console is keeping alive, and answer whether a specific object depends on it. DevTools holds a global handle on every object passed to `console.log` (and to any logger that funnels there), so with the console open those objects — and everything they transitively reference — live for the whole session. Those handles are REAL GC roots in the capture but do not exist in production, so they manufacture retainer paths that are indistinguishable from genuine ones in the DevTools retainer view. This is not the same question as `memlab_dev_artifacts`, which reports what is retained ONLY via dev roots in aggregate: an object can have a perfectly real production path AND a console-mediated one, and it is the console-mediated path that a retainer trace will usually show you. Run it before trusting any trace taken with DevTools attached.',
    {
      target_node_id: z
        .number()
        .optional()
        .describe(
          'Ask whether THIS object depends on the console: is it still reachable once every console-held root is cut? Answers the question a retainer trace cannot.',
        ),
      limit: z
        .number()
        .optional()
        .describe('Maximum inventory rows to list (default 20).'),
      handle: z
        .string()
        .optional()
        .describe('Snapshot to analyze (defaults to the active one).'),
    },
    async ({target_node_id, limit, handle}) => {
      try {
        const snapshot =
          handle != null ? getSnapshotByHandle(handle) : getSnapshot();
        if (snapshot == null) {
          return errorResult(
            new Error(
              handle != null
                ? `Snapshot "${handle}" is not resident.`
                : 'No snapshot loaded. Use memlab_load_snapshot first.',
            ),
          );
        }
        const maxRows = limit ?? 20;
        const devRoots = collectDevRoots(snapshot);
        const consoleRoots = consoleOnlyRoots(devRoots);

        if (consoleRoots.byId.size === 0) {
          return toolResult(
            '## Console retention\n\n' +
              '✅ **No console-held roots in this snapshot.** Either the console was clear when ' +
              'the capture was taken or DevTools was not attached. Retainer paths in this capture are ' +
              'not console-contaminated.',
          );
        }

        const kinds = inventory(snapshot, consoleRoots);
        const totalHeld = kinds.reduce((sum, k) => sum + k.count, 0);
        const totalBytes = kinds.reduce((sum, k) => sum + k.selfBytes, 0);

        const lines: string[] = [
          '## Console retention',
          '',
          // Not "held under N handles": the global handle is not a node with a
          // stable identity, so what is counted here is the console-HELD
          // OBJECTS, and calling the same number "handles" invents a second
          // measurement the tool never made.
          `The attached console is holding **${formatNumber(totalHeld)} object(s)** ` +
            `(${formatBytes(totalBytes)} self) across ${formatNumber(kinds.length)} distinct shape(s)` +
            (consoleRoots.byId.size > totalHeld
              ? `, and ${formatNumber(consoleRoots.byId.size - totalHeld)} further console-held root(s) that do not resolve in this snapshot.`
              : '.'),
          '',
        ];

        if (target_node_id != null) {
          const target = snapshot.getNodeById(target_node_id);
          if (target == null) {
            return errorResult(
              new Error(`Node @${target_node_id} not found in this snapshot.`),
            );
          }
          const reached = computeReachableWithoutDevRoots(
            snapshot,
            consoleRoots,
          );
          const survives = reached[target.nodeIndex] === 1;
          lines.push(
            `### Does @${target_node_id} depend on the console?`,
            '',
            survives
              ? `**No.** \`${target.name}\` @${target_node_id} is still reachable with every console-held root cut, ` +
                  'so its retention is real. A trace that happens to route through the console is showing ' +
                  'you one path of several — enumerate them with `memlab_island_doors`.'
              : `**Yes.** \`${target.name}\` @${target_node_id} is NOT reachable once console-held roots are cut. ` +
                  'In production this object would be collected. Any leak conclusion resting on it is an ' +
                  'artifact of capturing with the console attached — re-capture with the console clear.',
            '',
          );
        }

        lines.push(
          '### What is being held',
          '',
          markdownTable(
            ['Logged object', 'Count', 'Self', 'Sample'],
            kinds
              .slice(0, maxRows)
              .map(k => [
                k.label,
                formatNumber(k.count),
                formatBytes(k.selfBytes),
                `@${k.sampleId}`,
              ]),
            new Set([1, 2]),
          ),
          '',
        );
        if (kinds.length > maxRows) {
          lines.push(
            `_${formatNumber(kinds.length - maxRows)} more kind(s) not shown — raise \`limit\`._`,
            '',
          );
        }

        lines.push(
          '> **Bytes are the wrong measure here.** The self size is usually small; the damage is that ' +
            'each held object roots whatever it references. One console-held `MediaStream` was enough to ' +
            'keep a WeakMap entry alive whose value pointed at a closed popout `Window`, presenting a ' +
            'whole detached document as retained when production would have collected it.',
          '',
          'Fix the capture, not the reading: clear the console before snapshotting, or capture over CDP ' +
            'with no console attached. Where a logger streams objects continuously, clearing by hand does ' +
            'not hold — stringify the arguments at the log site or wrap the console for the duration of ' +
            'the run.',
        );
        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
