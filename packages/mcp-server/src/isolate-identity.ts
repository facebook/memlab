/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';

/**
 * V8 assigns each heap object an id when it is first reported and keeps it for
 * the object's lifetime, for every snapshot of the same isolate. Two captures
 * of one tab session (no reload) therefore share ids for the objects that
 * survived; captures of different isolates reuse the same id range for
 * unrelated objects. This tells the two apart by sampling ids from `before`
 * and checking that the node under the same id in `after` is the same kind of
 * object.
 */
export interface IsolateMatch {
  sameIsolate: boolean;
  sampled: number;
  /** Sampled ids that exist in `after`. */
  found: number;
  /** Found ids whose node has the same type and name on both sides. */
  matched: number;
}

/**
 * Only V8 heap objects keep their id for life. Blink's C++ (`native`) objects
 * are keyed by address, so once one is freed another can take its address and
 * its id; a DOM node is even renamed `Detached …` when it leaves the tree.
 * Between two captures of one idle tab a second apart, 5.6% of native ids
 * named a different object, which read as "different isolates".
 */
function hasStableId(node: IHeapNode): boolean {
  return node.id > 3 && node.type !== 'native' && node.type !== 'synthetic';
}

const SAMPLE = 20000;
// Survivors keep type and name exactly; a different isolate agrees only by
// chance, so the bar can sit high and still never be met by accident.
const MIN_AGREEMENT = 0.98;
const MIN_FOUND = 200;

export function compareIsolates(
  before: IHeapSnapshot,
  after: IHeapSnapshot,
): IsolateMatch {
  const total = before.nodes.length;
  const step = Math.max(1, Math.floor(total / SAMPLE));
  let sampled = 0;
  let found = 0;
  let matched = 0;
  for (let i = 0; i < total; i += step) {
    const a = before.nodes.get(i);
    if (a == null || !hasStableId(a)) continue;
    sampled++;
    const b = after.getNodeById(a.id);
    if (b == null) continue;
    found++;
    if (b.type === a.type && b.name === a.name) matched++;
  }
  return {
    sameIsolate: found >= MIN_FOUND && matched / found >= MIN_AGREEMENT,
    sampled,
    found,
    matched,
  };
}

export interface ClassChurn {
  key: string;
  type: string;
  name: string;
  added: number;
  deleted: number;
  addedSize: number;
  deletedSize: number;
}

function classKey(node: IHeapNode): string {
  return `${node.type}::${node.name}`;
}

/** A node that is the same object on both sides (same id, type and name). */
function survivor(node: IHeapNode, other: IHeapSnapshot): boolean {
  const o = other.getNodeById(node.id);
  return o != null && o.type === node.type && o.name === node.name;
}

/**
 * Per class: objects allocated after `before` and still alive in `after`
 * (added), and objects of `before` that are gone (deleted), with their self
 * sizes. This is the DevTools "Comparison" view. Unlike a histogram diff,
 * churn (N freed and N allocated) shows as N added and N deleted, not as 0.
 */
export function classChurn(
  before: IHeapSnapshot,
  after: IHeapSnapshot,
): Map<string, ClassChurn> {
  const out = new Map<string, ClassChurn>();
  const row = (node: IHeapNode): ClassChurn => {
    const key = classKey(node);
    let r = out.get(key);
    if (r == null) {
      r = {
        key,
        type: node.type,
        name: node.name,
        added: 0,
        deleted: 0,
        addedSize: 0,
        deletedSize: 0,
      };
      out.set(key, r);
    }
    return r;
  };
  after.nodes.forEach((n: IHeapNode) => {
    if (!hasStableId(n) || survivor(n, before)) return;
    const r = row(n);
    r.added++;
    r.addedSize += n.self_size;
  });
  before.nodes.forEach((n: IHeapNode) => {
    if (!hasStableId(n) || survivor(n, after)) return;
    const r = row(n);
    r.deleted++;
    r.deletedSize += n.self_size;
  });
  return out;
}

/** The added (in `after`) or deleted (in `before`) objects of one class. */
export function churnObjects(
  before: IHeapSnapshot,
  after: IHeapSnapshot,
  key: string,
  which: 'added' | 'deleted',
): IHeapNode[] {
  const [side, other] = which === 'added' ? [after, before] : [before, after];
  // Split the key once rather than building a key string per node.
  const sep = key.indexOf('::');
  const type = key.slice(0, sep);
  const name = key.slice(sep + 2);
  const out: IHeapNode[] = [];
  side.nodes.forEach((n: IHeapNode) => {
    if (n.type !== type || n.name !== name) return;
    if (!hasStableId(n) || survivor(n, other)) return;
    out.push(n);
  });
  // Largest first, ties by id, so the same call pages the same way twice.
  return out.sort((a, b) => b.self_size - a.self_size || a.id - b.id);
}
