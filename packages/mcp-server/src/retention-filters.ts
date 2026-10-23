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
import {z} from 'zod';
import {isContext} from './context-analysis.js';

/**
 * "Retained ONLY through X": objects reachable from the roots, but no longer
 * reachable once the walk refuses to step into X. Removing every X would free
 * them, so these are what X costs, with nothing double-counted against other
 * retainers.
 */
export const RETAINED_BY = [
  'contexts',
  'detached_dom',
  'console',
  'event_handlers',
] as const;
export type RetainedBy = (typeof RETAINED_BY)[number];

export const RETAINED_BY_LABEL: Record<RetainedBy, string> = {
  contexts: 'closure contexts',
  detached_dom: 'detached DOM nodes',
  console: 'the DevTools console',
  event_handlers: 'event handler functions',
};

export function retainedByParam() {
  return z
    .enum(RETAINED_BY)
    .optional()
    .describe(
      'Only objects retained ONLY through this: "contexts" (closure scopes), "detached_dom", "console" (objects logged with DevTools open) or "event_handlers" (functions registered as DOM event listeners). Removing every such retainer would free them.',
    );
}

/** Edge filter: may the walk step from `from` along `edge`? */
type Enter = (from: IHeapNode, edge: IHeapEdge) => boolean;

/** Ordinals reachable from the root over strong edges, honouring `enter`. */
export function reachableAvoiding(
  snapshot: IHeapSnapshot,
  enter?: Enter,
): Uint8Array {
  const count = snapshot.nodes.length;
  const seen = new Uint8Array(count);
  const queue = new Uint32Array(count);
  let tail = 0;
  seen[0] = 1;
  queue[tail++] = 0;
  for (let head = 0; head < tail; ++head) {
    const node = snapshot.nodes.get(queue[head]);
    if (node == null) continue;
    node.forEachReference((edge: IHeapEdge) => {
      if (edge.type === 'weak') return;
      const child = edge.toNode.nodeIndex;
      if (seen[child] || (enter != null && !enter(node, edge))) return;
      seen[child] = 1;
      queue[tail++] = child;
    });
  }
  return seen;
}

function hasCode(node: IHeapNode): boolean {
  return node.getReferenceNode('code') != null;
}

/**
 * Blink keeps each registered listener as a `V8EventListener` whose slot `1`
 * (`callback_object_`) is the handler function, or a framework wrapper
 * holding it. The function is what the filter refuses to enter.
 */
function eventHandlerOrdinals(snapshot: IHeapSnapshot): Set<number> {
  const handlers = new Set<number>();
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.name !== 'V8EventListener') return;
    const callback = node.findAnyReference(
      (e: IHeapEdge) => String(e.name_or_index) === '1',
    )?.toNode;
    if (callback == null) return;
    if (hasCode(callback)) {
      handlers.add(callback.nodeIndex);
      return;
    }
    const inner = callback.findAnyReference((e: IHeapEdge) =>
      hasCode(e.toNode),
    )?.toNode;
    handlers.add((inner ?? callback).nodeIndex);
  });
  return handlers;
}

function enterFor(snapshot: IHeapSnapshot, by: RetainedBy): Enter {
  switch (by) {
    case 'contexts':
      return (_from, edge) => !isContext(edge.toNode);
    case 'detached_dom':
      return (_from, edge) => !edge.toNode.is_detached;
    case 'console':
      return (from, edge) =>
        !(
          from.type === 'synthetic' &&
          String(edge.name_or_index).endsWith(' / DevTools console')
        );
    case 'event_handlers': {
      const handlers = eventHandlerOrdinals(snapshot);
      return (_from, edge) => !handlers.has(edge.toNode.nodeIndex);
    }
  }
}

interface Cached {
  base?: Uint8Array;
  masks: Map<RetainedBy, Uint8Array>;
}
const cache = new WeakMap<IHeapSnapshot, Cached>();

/** 1 for every ordinal retained only through `by`. Cached per snapshot. */
export function retainedOnlyBy(
  snapshot: IHeapSnapshot,
  by: RetainedBy,
): Uint8Array {
  let c = cache.get(snapshot);
  if (c == null) {
    c = {masks: new Map()};
    cache.set(snapshot, c);
  }
  const hit = c.masks.get(by);
  if (hit != null) return hit;
  const base = (c.base ??= reachableAvoiding(snapshot));
  const avoiding = reachableAvoiding(snapshot, enterFor(snapshot, by));
  const mask = new Uint8Array(base.length);
  for (let i = 0; i < base.length; ++i) {
    mask[i] = base[i] && !avoiding[i] ? 1 : 0;
  }
  c.masks.set(by, mask);
  return mask;
}
