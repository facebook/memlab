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
 * Unsettled promises and the length of their reaction chains.
 *
 * A promise that never settles keeps every `.then` callback attached to it,
 * each a `system / PromiseReaction` linked to the next. Counting unsettled
 * promises misses the case that matters: ONE promise with a thousand
 * reactions, growing by a few per interaction, among thousands of short-lived
 * ones. The chain is followed by node type rather than by edge name — V8 names
 * the link by its slot index, and walking the wrong slot reads a length of 1.
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';

const REACTION = 'system / PromiseReaction';
const DEFAULT_CAP = 1_000_000;

function firstReaction(promise: IHeapNode): IHeapNode | null {
  for (const e of promise.references) {
    if (e.toNode.name === REACTION) return e.toNode;
  }
  return null;
}

export function isPendingPromise(node: IHeapNode): boolean {
  return (
    node.type === 'object' &&
    node.name === 'Promise' &&
    firstReaction(node) != null
  );
}

/** The reactions attached to an unsettled promise (none when it settled). */
export function promiseReactions(
  promise: IHeapNode,
  cap = DEFAULT_CAP,
): {count: number; ids: number[]; truncated: boolean} {
  const ids: number[] = [];
  const seen = new Set<number>();
  let cur = firstReaction(promise);
  while (cur != null && !seen.has(cur.id)) {
    if (ids.length >= cap) return {count: ids.length, ids, truncated: true};
    seen.add(cur.id);
    ids.push(cur.id);
    let next: IHeapNode | null = null;
    for (const e of cur.references) {
      if (e.toNode.name === REACTION && !seen.has(e.toNode.id)) {
        next = e.toNode;
        break;
      }
    }
    cur = next;
  }
  return {count: ids.length, ids, truncated: false};
}

/** Every unsettled promise with its chain length, longest first. */
export function pendingPromises(
  snapshot: IHeapSnapshot,
): Array<{node: IHeapNode; reactions: number}> {
  const out: Array<{node: IHeapNode; reactions: number}> = [];
  snapshot.nodes.forEach(node => {
    if (node.type !== 'object' || node.name !== 'Promise') return;
    if (firstReaction(node) == null) return;
    out.push({node, reactions: promiseReactions(node).count});
  });
  out.sort((a, b) => b.reactions - a.reactions);
  return out;
}
