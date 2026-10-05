/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * React refs whose `.current` is detached DOM, grouped by owner.
 *
 * Three rounds each needed four evals to reach one conclusion: "71 stale refs
 * for 72 cells — bounded". A ref left pointing at an unmounted node is normal
 * per instance (the next render overwrites it). It is a leak only when one
 * owner holds more stale refs than it has instances, or when the count climbs
 * across rungs. So the census pairs each group with how many fibers render
 * its owner.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  fiberComponentName,
  isFiberNode,
  nearestFiber,
} from '../react-shapes.js';
import {isDetachedDOMNode} from './detached-dom.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

function isRefObject(node: IHeapNode): IHeapNode | null {
  if (node.type !== 'object' || node.name !== 'Object') return null;
  let current: IHeapNode | null = null;
  let props = 0;
  for (const e of node.references) {
    if (e.type !== 'property') continue;
    const name = String(e.name_or_index);
    if (name === '__proto__') continue;
    props++;
    if (name === 'current') current = e.toNode;
  }
  return props === 1 ? current : null;
}

/** A fiber's component identity: its `type` (the function or class), by id. */
function fiberTypeId(fiber: IHeapNode): number | null {
  for (const e of fiber.references) {
    if (String(e.name_or_index) === 'type') return e.toNode.id;
  }
  return null;
}

/** The name the ref is held under: a closure variable, a property, or a hook. */
function holderOf(
  ref: IHeapNode,
  maxHops: number,
): {owner: string; ownerType: number | null; via: string} {
  // Precedence, independent of referrer order: a hook, then a closure
  // variable, then the first non-numeric property, then any property.
  let hook = false;
  let context: string | null = null;
  let named: string | null = null;
  let anyProp: string | null = null;
  for (const e of ref.referrers) {
    const edge = String(e.name_or_index);
    if (e.type !== 'context' && e.type !== 'property') continue;
    if (edge === 'memoizedState') hook = true;
    else if (e.type === 'context') context ??= edge;
    else if (!/^\d+$/.test(edge)) named ??= edge;
    else anyProp ??= edge;
  }
  const via = hook ? 'useRef' : (context ?? named ?? anyProp ?? '(unnamed)');
  const fiber = nearestFiber(ref, maxHops);
  const owner =
    fiber != null ? (fiberComponentName(fiber) ?? '(anonymous)') : '(no fiber)';
  return {owner, ownerType: fiber != null ? fiberTypeId(fiber) : null, via};
}

export function registerStaleRefs(server: McpServer): void {
  server.tool(
    'memlab_stale_refs',
    'React refs (`{current}` objects) whose `.current` is DETACHED DOM, grouped by owning component and the name the ref is held under (closure variable, property, or `useRef`), with the number of fibers rendering that component. One stale ref per instance is normal (the next render overwrites it) and bounded; more stale refs than instances, or a count that climbs across rungs, is accumulation.',
    {
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(20)
        .describe('Groups to list (default 20).'),
      max_hops: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(12)
        .describe('Referrer hops searched for the owning fiber (default 12).'),
    },
    async ({limit, max_hops}) => {
      try {
        const snapshot = getSnapshot();
        // Keyed by the component's `type`, not its name: minified or generic
        // names ("Row") are shared by distinct components, and merging them
        // would pool their fiber counts.
        const groups = new Map<
          string,
          {
            owner: string;
            ownerType: number | null;
            via: string;
            refs: number;
            example: number;
          }
        >();
        let total = 0;
        snapshot.nodes.forEach(node => {
          const current = isRefObject(node);
          if (current == null || !isDetachedDOMNode(current)) return;
          total++;
          const {owner, ownerType, via} = holderOf(node, max_hops);
          const key = `${ownerType ?? owner}\u0000${via}`;
          const g = groups.get(key);
          if (g) g.refs++;
          else
            groups.set(key, {owner, ownerType, via, refs: 1, example: node.id});
        });
        if (total === 0) {
          return toolResult(
            'No React ref (`{current}`) points at detached DOM.',
          );
        }
        const ownerTypes = new Set(
          [...groups.values()].flatMap(g =>
            g.ownerType != null ? [g.ownerType] : [],
          ),
        );
        const fibers = new Map<number, number>();
        snapshot.nodes.forEach(node => {
          if (!isFiberNode(node)) return;
          const t = fiberTypeId(node);
          if (t != null && ownerTypes.has(t)) {
            fibers.set(t, (fibers.get(t) ?? 0) + 1);
          }
        });
        // A name carried by more than one component gets its type id shown.
        const typesByName = new Map<string, Set<number>>();
        for (const g of groups.values()) {
          if (g.ownerType == null) continue;
          const set = typesByName.get(g.owner) ?? new Set<number>();
          set.add(g.ownerType);
          typesByName.set(g.owner, set);
        }
        const rows = [...groups.values()].sort((a, b) => b.refs - a.refs);
        return toolResult(
          [
            `## Stale React refs — ${formatNumber(total)} \`{current}\` object(s) pointing at detached DOM`,
            '',
            markdownTable(
              [
                'Owner',
                'Held as',
                'Stale refs',
                'Owner fibers',
                'Refs / fiber',
                'Example',
              ],
              rows.slice(0, limit).map(g => {
                const f =
                  g.ownerType != null ? (fibers.get(g.ownerType) ?? 0) : 0;
                return [
                  (typesByName.get(g.owner)?.size ?? 0) > 1
                    ? `${g.owner} (type @${g.ownerType})`
                    : g.owner,
                  g.via,
                  formatNumber(g.refs),
                  f > 0 ? formatNumber(f) : '—',
                  f > 0 ? (g.refs / f).toFixed(2) : '—',
                  `@${g.example}`,
                ];
              }),
              new Set([2, 3, 4]),
            ),
            '',
            '_**Owner fibers** counts every fiber rendering the component (matched by its function or class, not its name), current and alternate alike, so a mounted instance can count twice. **Refs / fiber** at or under ~1 is a bounded working set (one stale ref per instance until its next render). Well above 1, or rising across rungs, is accumulation: trace the example with `memlab_retainer_trace`._',
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
