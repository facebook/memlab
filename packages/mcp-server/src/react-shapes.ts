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
 * Recognising React structures in a heap snapshot.
 *
 * Fibers, hooks, update queues and update records are ALL plain `Object` in a
 * production bundle, so every class-name-based heuristic walks straight past
 * them. On one population `helpers.owner()` returned `(none)` for 100% of
 * 1,645 records for exactly this reason, and the useful answer —
 * `BaseTooltipSimple` — needed a hand-written walk to the fiber plus a read of
 * `elementType`.
 *
 * That walk has now been hand-written for four findings of the same family
 * across this workstream. The `elementType` / `stateNode` / `memoizedProps`
 * layout is stable across every React version Meta ships, so it belongs here
 * rather than in each investigation.
 */

import type {IHeapNode} from '@memlab/core';

/**
 * Fields that only a fiber carries. `stateNode` alone is too weak (a class
 * instance has one), so a match needs `elementType` or `memoizedProps`, which
 * together with `return`/`child` are fiber-specific.
 */
const FIBER_STRONG_FIELDS = ['elementType', 'memoizedProps', 'pendingProps'];
const FIBER_SUPPORTING_FIELDS = [
  'return',
  'child',
  'stateNode',
  'memoizedState',
];

/** Property set of a React update record — the eager-bailout leak family. */
export const UPDATE_RECORD_FIELDS = [
  'action',
  'eagerState',
  'hasEagerState',
  'lane',
  'next',
];

/** Own property names of a node, as a Set. Cheap; used by every check here. */
function propertyNames(node: IHeapNode): Set<string> {
  const names = new Set<string>();
  for (const edge of node.references) {
    if (edge.type !== 'property') continue;
    names.add(String(edge.name_or_index));
  }
  return names;
}

/** Does this node look like a React fiber? */
export function isFiberNode(node: IHeapNode): boolean {
  if (node.type !== 'object') return false;
  const names = propertyNames(node);
  const strong = FIBER_STRONG_FIELDS.filter(f => names.has(f)).length;
  if (strong === 0) return false;
  const supporting = FIBER_SUPPORTING_FIELDS.filter(f => names.has(f)).length;
  return strong + supporting >= 3;
}

/** Does this node look like a React update record (`queue.pending` member)? */
export function isUpdateRecord(node: IHeapNode): boolean {
  if (node.type !== 'object') return false;
  const names = propertyNames(node);
  // `eagerState` may be absent when the update never took the eager path, so
  // require the rest and treat it as optional.
  return (
    names.has('action') &&
    names.has('lane') &&
    names.has('next') &&
    (names.has('hasEagerState') || names.has('eagerState'))
  );
}

/**
 * The component name behind a fiber.
 *
 * Three shapes, in the order they occur: `elementType` is a closure (function
 * component — the closure's own name is the component name), or a string (host
 * element), or an object carrying `render` / `type` (memo, forwardRef, lazy),
 * in which case the name is one level deeper.
 */
export function fiberComponentName(fiber: IHeapNode): string | null {
  for (const edge of fiber.references) {
    if (edge.type !== 'property') continue;
    if (String(edge.name_or_index) !== 'elementType') continue;
    return elementTypeName(edge.toNode, 0);
  }
  return null;
}

function elementTypeName(node: IHeapNode, depth: number): string | null {
  if (depth > 2) return null;
  if (node.type === 'string' || node.type === 'concatenated string') {
    const value = node.toStringNode()?.stringValue ?? node.name;
    return value ? `<${value}>` : null;
  }
  if (node.type === 'closure') {
    // A minified bundle still names the closure after the component in the
    // overwhelming majority of cases; an empty name is worth reporting as
    // unknown rather than as "".
    return node.name && node.name !== 'function' ? node.name : null;
  }
  // memo / forwardRef / lazy wrappers.
  for (const edge of node.references) {
    if (edge.type !== 'property') continue;
    const name = String(edge.name_or_index);
    if (name !== 'render' && name !== 'type') continue;
    const inner = elementTypeName(edge.toNode, depth + 1);
    if (inner != null) return inner;
  }
  return null;
}

/**
 * Walk up from a hook/queue/record to the fiber that owns it.
 *
 * Prefers the edges that actually lead there — a hook's owner is reached via
 * `memoizedState` / `next` / `queue` / `baseQueue`, not by whatever referrer
 * happens to come first — and falls back to any referrer so a slightly
 * different shape still resolves.
 */
const OWNER_EDGE_PREFERENCE = [
  'memoizedState',
  'queue',
  'baseQueue',
  'next',
  'return',
];

export function nearestFiber(
  node: IHeapNode,
  maxHops: number,
): IHeapNode | null {
  let current: IHeapNode = node;
  const seen = new Set<number>([node.id]);
  for (let hop = 0; hop < maxHops; hop++) {
    if (isFiberNode(current)) return current;
    let chosen: IHeapNode | null = null;
    let fallback: IHeapNode | null = null;
    for (const edge of current.referrers) {
      const from = edge.fromNode;
      if (from.id <= 3 || seen.has(from.id)) continue;
      if (OWNER_EDGE_PREFERENCE.includes(String(edge.name_or_index))) {
        chosen = from;
        break;
      }
      if (fallback == null) fallback = from;
    }
    const next = chosen ?? fallback;
    if (next == null) return null;
    seen.add(next.id);
    current = next;
  }
  return null;
}

/** A value as a short label: oddballs and strings inline, objects by class. */
export function describeValue(node: IHeapNode | null): string {
  if (node == null) return 'smi'; // an inline small integer emits no edge
  if (['true', 'false', 'null', 'undefined'].includes(node.name)) {
    return node.name;
  }
  if (node.isString) {
    const s = node.toStringNode()?.stringValue ?? node.name;
    return JSON.stringify(s.length > 24 ? `${s.slice(0, 24)}…` : s);
  }
  if (node.type === 'number' || node.name === 'heap number') return 'number';
  return `<${node.name || node.type}>`;
}

/** The target of `node`'s edge named `name`, or null (also for a sentinel root). */
export function edgeTo(node: IHeapNode, name: string): IHeapNode | null {
  for (const e of node.references) {
    if (String(e.name_or_index) === name)
      return e.toNode.id > 3 ? e.toNode : null;
  }
  return null;
}

export interface HookInfo {
  /** 0-based position in the fiber's hook list. */
  index: number;
  /** 1-based position among STATEFUL hooks (useState/useReducer) only. */
  statefulOrdinal: number | null;
  kind: 'state' | 'reducer' | 'other';
  queue: IHeapNode | null;
  hook: IHeapNode;
}

/**
 * The fiber's hook list, in order. A hook is stateful when its `queue` holds
 * an object: effect, ref and memo hooks have none. The ordinal counts only
 * those, which is what maps "hook #9 in the list" back to "the third useState
 * in the component source" — inferred by hand in every eager-bailout finding.
 */
export function hooksOfFiber(fiber: IHeapNode, maxHooks = 200): HookInfo[] {
  const out: HookInfo[] = [];
  let hook = edgeTo(fiber, 'memoizedState');
  let stateful = 0;
  const seen = new Set<number>();
  while (hook != null && out.length < maxHooks && !seen.has(hook.id)) {
    seen.add(hook.id);
    // A class component's memoizedState is its state object, not a hook.
    if (!propertyNames(hook).has('next') && out.length === 0) break;
    const queue = edgeTo(hook, 'queue');
    const isStateful = queue != null && queue.type === 'object';
    if (isStateful) stateful++;
    const reducer = queue != null ? edgeTo(queue, 'lastRenderedReducer') : null;
    out.push({
      index: out.length,
      statefulOrdinal: isStateful ? stateful : null,
      kind: !isStateful
        ? 'other'
        : reducer?.name === 'basicStateReducer'
          ? 'state'
          : 'reducer',
      queue: isStateful ? queue : null,
      hook,
    });
    hook = edgeTo(hook, 'next');
  }
  return out;
}

export interface QueueDetail {
  hook: HookInfo | null;
  lastRenderedState: string;
  actions: Array<{value: string; count: number}>;
  /** Every pending action is the very value last rendered: the eager-bailout signature. */
  bailout: boolean | null;
  dispatchHolders: string[];
}

/** Hook position, pending-action histogram and dispatch holders of one queue. */
export function describeQueue(
  queue: IHeapNode,
  fiber: IHeapNode | null,
  maxChain = 5000,
  /** The queue's hook when the caller already walked the fiber's hooks. */
  knownHook?: HookInfo,
): QueueDetail {
  const hook =
    knownHook ??
    (fiber != null
      ? (hooksOfFiber(fiber).find(h => h.queue?.id === queue.id) ?? null)
      : null);
  const last = edgeTo(queue, 'lastRenderedState');
  const lastLabel = describeValue(last);
  const counts = new Map<string, number>();
  let allSame: boolean | null = true;
  const seen = new Set<number>();
  for (
    let rec = edgeTo(queue, 'pending');
    rec != null && isUpdateRecord(rec) && !seen.has(rec.id);
  ) {
    if (seen.size >= maxChain) {
      // Truncated: a differing action already seen still settles "no", but
      // "every action matched" is only known for the part that was read.
      if (allSame === true) allSame = null;
      break;
    }
    seen.add(rec.id);
    const action = edgeTo(rec, 'action');
    const label = describeValue(action);
    counts.set(label, (counts.get(label) ?? 0) + 1);
    // An SMI emits no node, so its value is not in the snapshot: two SMIs
    // may still differ, and only an id match proves "same value".
    if (action == null || last == null)
      allSame = allSame === false ? false : null;
    else if (action.id !== last.id) allSame = false;
    rec = edgeTo(rec, 'next');
  }
  const dispatch = edgeTo(queue, 'dispatch');
  const holders: string[] = [];
  if (dispatch != null) {
    for (const e of dispatch.referrers) {
      if (e.fromNode.id === queue.id || holders.length >= 3) continue;
      holders.push(
        `${e.fromNode.name || e.fromNode.type}.${String(e.name_or_index)}`,
      );
    }
  }
  return {
    hook,
    lastRenderedState: lastLabel,
    actions: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([value, count]) => ({value, count})),
    bailout: seen.size === 0 ? null : allSame,
    dispatchHolders: holders,
  };
}
