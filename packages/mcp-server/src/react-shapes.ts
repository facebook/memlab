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
