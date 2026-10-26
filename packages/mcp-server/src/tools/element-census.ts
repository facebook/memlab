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
 * Retained React elements and fibers by component type, and what holds them.
 *
 * A fiber is mounted when the committed tree reaches it (`child` / `sibling`
 * from a root's `current`), an alternate when it is a mounted fiber's
 * `alternate`, and detached otherwise. An element is classed by the nearest
 * cause on its shortest retainer path: an update queue, a closure variable, a
 * dev-only `_debug*` / `_owner` field, or else the fiber it reaches. Element
 * trees pinned by something other than the mounted tree are what grows when a
 * component leaks.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  elementTypeName,
  fiberComponentName,
  isFiberNode,
} from '../react-shapes.js';
import {
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
  withSnapshotAt,
} from '../snapshot-borrow.js';
import {rungPaths} from './eval-across.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

const HOLDERS = [
  'mounted',
  'alternate',
  'detached fiber',
  'update queue',
  'closure',
  'dev debug',
  'other',
] as const;
type Holder = (typeof HOLDERS)[number];
type FiberState = 'mounted' | 'alternate' | 'detached';

const QUEUE_EDGES = new Set([
  'updateQueue',
  'queue',
  'baseQueue',
  'pending',
  'firstBaseUpdate',
  'lastBaseUpdate',
]);
const DEBUG_EDGE_RE = /^(_debug|_owner$|_store$)/;

function prop(node: IHeapNode, name: string): IHeapNode | null {
  for (const e of node.references) {
    if (e.type === 'property' && e.name_or_index === name) return e.toNode;
  }
  return null;
}

function isElement(node: IHeapNode): boolean {
  if (node.type !== 'object') return false;
  let typeof_ = false;
  let props = false;
  let type = false;
  for (const e of node.references) {
    if (e.type !== 'property') continue;
    const n = e.name_or_index;
    if (n === '$$typeof') typeof_ = true;
    else if (n === 'props') props = true;
    else if (n === 'type') type = true;
  }
  return typeof_ && props && type;
}

/** Mounted / alternate state of every fiber, from the roots' committed trees. */
function fiberStates(
  snapshot: IHeapSnapshot,
  fibers: Set<number>,
): Map<number, FiberState> {
  const state = new Map<number, FiberState>();
  const stack: IHeapNode[] = [];
  snapshot.nodes.forEach((n: IHeapNode) => {
    if (n.type !== 'object' || prop(n, 'containerInfo') == null) return;
    const current = prop(n, 'current');
    if (current != null && fibers.has(current.id)) stack.push(current);
  });
  while (stack.length > 0) {
    const f = stack.pop() as IHeapNode;
    if (state.get(f.id) === 'mounted') continue;
    state.set(f.id, 'mounted');
    for (const name of ['child', 'sibling']) {
      const next = prop(f, name);
      if (next != null && fibers.has(next.id)) stack.push(next);
    }
  }
  for (const [id, s] of [...state]) {
    if (s !== 'mounted') continue;
    const alt = prop(snapshot.getNodeById(id) as IHeapNode, 'alternate');
    if (alt != null && fibers.has(alt.id) && !state.has(alt.id)) {
      state.set(alt.id, 'alternate');
    }
  }
  return state;
}

function holderOf(
  node: IHeapNode,
  fibers: Set<number>,
  state: Map<number, FiberState>,
): Holder {
  let cur: IHeapNode = node;
  for (let hop = 0; hop < 64; hop++) {
    const e = cur.pathEdge;
    if (e == null) return 'other';
    const name = String(e.name_or_index);
    if (QUEUE_EDGES.has(name)) return 'update queue';
    if (e.type === 'context') return 'closure';
    if (DEBUG_EDGE_RE.test(name)) return 'dev debug';
    const from = e.fromNode;
    if (fibers.has(from.id)) {
      const s = state.get(from.id) ?? 'detached';
      return s === 'detached' ? 'detached fiber' : s;
    }
    cur = from;
  }
  return 'other';
}

interface ComponentRow {
  elements: number;
  fibers: Record<FiberState, number>;
  holders: Map<Holder, number>;
}

export function elementCensus(
  snapshot: IHeapSnapshot,
): Map<string, ComponentRow> {
  const fibers = new Set<number>();
  const elements: IHeapNode[] = [];
  snapshot.nodes.forEach((n: IHeapNode) => {
    if (n.type !== 'object') return;
    if (isElement(n)) elements.push(n);
    else if (isFiberNode(n)) fibers.add(n.id);
  });
  const state = fiberStates(snapshot, fibers);
  const rows = new Map<string, ComponentRow>();
  const rowOf = (name: string): ComponentRow => {
    let r = rows.get(name);
    if (r == null) {
      r = {
        elements: 0,
        fibers: {mounted: 0, alternate: 0, detached: 0},
        holders: new Map(),
      };
      rows.set(name, r);
    }
    return r;
  };
  for (const id of fibers) {
    const f = snapshot.getNodeById(id);
    if (f == null) continue;
    rowOf(fiberComponentName(f) ?? '(unknown)').fibers[
      state.get(id) ?? 'detached'
    ]++;
  }
  for (const el of elements) {
    const type = prop(el, 'type');
    const r = rowOf(
      (type != null ? elementTypeName(type) : null) ?? '(unknown)',
    );
    r.elements++;
    const h = holderOf(el, fibers, state);
    r.holders.set(h, (r.holders.get(h) ?? 0) + 1);
  }
  return rows;
}

function holderText(r: ComponentRow): string {
  return HOLDERS.filter(h => (r.holders.get(h) ?? 0) > 0)
    .map(h => `${h} ${formatNumber(r.holders.get(h) ?? 0)}`)
    .join(', ');
}

function fiberText(r: ComponentRow): string {
  const f = r.fibers;
  return `${formatNumber(f.mounted)} / ${formatNumber(f.alternate)} / ${formatNumber(f.detached)}`;
}

export function registerElementCensus(server: McpServer): void {
  server.tool(
    'memlab_element_census',
    "Retained React elements and fibers by component type. Fibers are split into mounted (reached by the committed tree from a root), alternate (a mounted fiber's `alternate`) and detached; elements by what holds them: the mounted tree, an alternate, a detached fiber, an update queue, a closure variable, a dev-only `_debug*`/`_owner` field, or other. Element trees pinned outside the mounted tree are what grows when a component leaks. With `run_dir` or `paths`, elements + fibers per component at every rung, sorted by growth, with the holder split at the last rung.",
    {
      component: z
        .string()
        .optional()
        .describe('Only components whose name contains this.'),
      run_dir: z
        .string()
        .optional()
        .describe('A leak-hunt round: measure the rungs of its ladder.'),
      rungs: z
        .array(z.number().int())
        .optional()
        .describe(
          'With `run_dir`, which rungs (0-based; negative counts from the end). Default: all.',
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Snapshot files to measure in order, instead of the active snapshot.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(15)
        .describe('Components to list (default 15).'),
    },
    async ({component, run_dir, rungs, paths, limit}) => {
      try {
        const keep = (name: string) =>
          component == null || component === '' || name.includes(component);
        const files =
          run_dir != null && run_dir !== ''
            ? rungPaths(run_dir, rungs)
            : (paths ?? []);
        const legend =
          '_Fibers: mounted / alternate / detached. "closure", "update queue" and "detached fiber" holders are outside the committed tree; "dev debug" exists only in development builds._';
        if (files.length === 0) {
          const rows = [...elementCensus(getSnapshot()).entries()]
            .filter(([name]) => keep(name))
            .sort(
              (a, b) =>
                b[1].elements +
                b[1].fibers.detached -
                (a[1].elements + a[1].fibers.detached),
            );
          if (rows.length === 0) {
            return toolResult(
              'No React elements or fibers here (objects with `$$typeof`/`type`/`props`, or with `elementType`/`memoizedProps`).',
            );
          }
          const total = rows.reduce((s, [, r]) => s + r.elements, 0);
          const fiberTotal = rows.reduce(
            (s, [, r]) =>
              s + r.fibers.mounted + r.fibers.alternate + r.fibers.detached,
            0,
          );
          return toolResult(
            [
              '## React element census',
              '',
              `${formatNumber(total)} element(s) and ${formatNumber(fiberTotal)} fiber(s) across ${formatNumber(rows.length)} component type(s).`,
              '',
              markdownTable(
                ['Component', 'Elements', 'Elements held by', 'Fibers'],
                rows
                  .slice(0, limit)
                  .map(([name, r]) => [
                    name,
                    formatNumber(r.elements),
                    holderText(r),
                    fiberText(r),
                  ]),
                new Set([1]),
              ),
              '',
              legend,
            ].join('\n'),
          );
        }

        const {rungs: resolved, largestMB} = resolveRungs(files);
        const perRung: Array<Map<string, ComponentRow>> = [];
        for (const rung of resolved) {
          armScanBudgetFor(scaledTimeoutMs(largestMB));
          perRung.push(await withSnapshotAt(rung.localPath, elementCensus));
        }
        const size = (r: ComponentRow | undefined) =>
          r == null
            ? 0
            : r.elements +
              r.fibers.mounted +
              r.fibers.alternate +
              r.fibers.detached;
        const last = perRung[perRung.length - 1];
        const names = [...new Set(perRung.flatMap(m => [...m.keys()]))]
          .filter(keep)
          .map(name => {
            const series = perRung.map(m => size(m.get(name)));
            return {name, series, delta: series[series.length - 1] - series[0]};
          })
          .filter(r => r.delta !== 0)
          .sort((a, b) => b.delta - a.delta)
          .slice(0, limit);
        if (names.length === 0) {
          return toolResult(
            `No component's elements + fibers changed across ${resolved.length} rung(s).`,
          );
        }
        return toolResult(
          [
            '## React element census per rung (elements + fibers)',
            '',
            markdownTable(
              [
                'Component',
                ...resolved.map((_, i) => `#${i + 1}`),
                'Δ',
                'Last rung: elements held by',
                'Fibers',
              ],
              names.map(({name, series, delta}) => {
                const r = last.get(name);
                return [
                  name,
                  ...series.map(v => formatNumber(v)),
                  `${delta >= 0 ? '+' : ''}${formatNumber(delta)}`,
                  r != null ? holderText(r) : '',
                  r != null ? fiberText(r) : '',
                ];
              }),
              new Set(resolved.map((_, i) => i + 1)),
            ),
            '',
            legend,
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
