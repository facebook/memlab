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

/**
 * Which JavaScript realm (V8 NativeContext: a page, an iframe, an extension's
 * isolated world, a Node `vm` context) owns each object of ONE snapshot.
 *
 * Two steps:
 * 1. Pin what the heap states outright. Every JS object points at its Map,
 *    every Map at its meta-map, and each realm has its own meta-map with a
 *    `native_context` edge. Object → map → meta-map → NativeContext names the
 *    owner of every object with a realm-specific map.
 * 2. Spread ownership along strong edges from the pinned objects. An object
 *    reached from two realms is SHARED; one no realm reaches (engine
 *    internals, strings and code reached only from roots) is UNATTRIBUTED.
 */

export const UNATTRIBUTED = -1;
export const SHARED = -2;

export interface NativeContextInfo {
  ordinal: number;
  id: number;
  /** The realm's tag, usually its URL, or '' when V8 recorded none. */
  label: string;
  detached: boolean;
  selfSize: number;
  retainedSize: number;
  /** Self sizes of every object owned by this realm alone. */
  attributedSize: number;
  attributedCount: number;
}

export interface NativeContextAttribution {
  /** Owner per node ordinal: a NativeContext ordinal, SHARED or UNATTRIBUTED. */
  owner: Int32Array;
  contexts: NativeContextInfo[];
  sharedSize: number;
  sharedCount: number;
  unattributedSize: number;
  unattributedCount: number;
}

const PREFIXES = ['system / NativeContext', 'Detached system / NativeContext'];

function isNativeContext(name: string): boolean {
  return PREFIXES.some(p => name === p || name.startsWith(p + ' / '));
}

function contextLabel(name: string): string {
  for (const p of PREFIXES) {
    if (name.startsWith(p + ' / ')) return name.slice(p.length + 3);
  }
  return '';
}

const cache = new WeakMap<IHeapSnapshot, NativeContextAttribution>();

export function nativeContextAttribution(
  snapshot: IHeapSnapshot,
): NativeContextAttribution {
  const hit = cache.get(snapshot);
  if (hit != null) return hit;

  const count = snapshot.nodes.length;
  const owner = new Int32Array(count).fill(UNATTRIBUTED);
  const fixed = new Uint8Array(count);
  const mapOf = new Int32Array(count).fill(-1);
  const realmOf = new Int32Array(count).fill(-1);
  const contextOrdinals: number[] = [];

  snapshot.nodes.forEach((node: IHeapNode) => {
    const idx = node.nodeIndex;
    if (isNativeContext(node.name)) contextOrdinals.push(idx);
    node.forEachReference((edge: IHeapEdge) => {
      if (edge.type !== 'internal') return;
      if (edge.name_or_index === 'map' && mapOf[idx] < 0) {
        mapOf[idx] = edge.toNode.nodeIndex;
      } else if (
        edge.name_or_index === 'native_context' &&
        realmOf[idx] < 0 &&
        isNativeContext(edge.toNode.name)
      ) {
        realmOf[idx] = edge.toNode.nodeIndex;
      }
    });
  });

  const queue: number[] = [];
  for (const idx of contextOrdinals) {
    owner[idx] = idx;
    fixed[idx] = 1;
  }
  for (let idx = 0; idx < count; ++idx) {
    if (fixed[idx]) {
      queue.push(idx);
      continue;
    }
    const map = mapOf[idx];
    const meta = map >= 0 ? mapOf[map] : -1;
    const realm = meta >= 0 ? realmOf[meta] : -1;
    if (realm >= 0) {
      owner[idx] = realm;
      fixed[idx] = 1;
      queue.push(idx);
    }
  }

  // Breadth-first from the pinned objects. A node whose owner changes (first
  // reached, or reached from a second realm) is queued again so the change
  // reaches what it holds; owners only move towards SHARED, so this ends.
  for (let head = 0; head < queue.length; ++head) {
    const idx = queue[head];
    const from = owner[idx];
    const node = snapshot.nodes.get(idx);
    if (node == null) continue;
    node.forEachReference((edge: IHeapEdge) => {
      if (edge.type === 'weak' || edge.type === 'shortcut') return;
      const child = edge.toNode.nodeIndex;
      if (child === idx || fixed[child]) return;
      const cur = owner[child];
      const next = cur === UNATTRIBUTED ? from : cur === from ? cur : SHARED;
      if (next !== cur) {
        owner[child] = next;
        queue.push(child);
      }
    });
  }

  const infoByOrdinal = new Map<number, NativeContextInfo>();
  const contexts = contextOrdinals.map(idx => {
    const node = snapshot.nodes.get(idx) as IHeapNode;
    const info: NativeContextInfo = {
      ordinal: idx,
      id: node.id,
      label: contextLabel(node.name),
      detached: node.name.startsWith('Detached '),
      selfSize: node.self_size,
      retainedSize: node.retainedSize,
      attributedSize: 0,
      attributedCount: 0,
    };
    infoByOrdinal.set(idx, info);
    return info;
  });
  const result: NativeContextAttribution = {
    owner,
    contexts,
    sharedSize: 0,
    sharedCount: 0,
    unattributedSize: 0,
    unattributedCount: 0,
  };
  snapshot.nodes.forEach((node: IHeapNode) => {
    const o = owner[node.nodeIndex];
    const size = node.self_size;
    if (o === SHARED) {
      result.sharedSize += size;
      result.sharedCount++;
    } else if (o === UNATTRIBUTED) {
      result.unattributedSize += size;
      result.unattributedCount++;
    } else {
      const info = infoByOrdinal.get(o);
      if (info != null) {
        info.attributedSize += size;
        info.attributedCount++;
      }
    }
  });
  contexts.sort((a, b) => b.attributedSize - a.attributedSize || a.id - b.id);
  cache.set(snapshot, result);
  return result;
}

/**
 * Resolve a `native_context` filter value: a NativeContext node id, "shared"
 * or "unattributed". Returns the owner value to match, or an error message.
 */
export function resolveNativeContextFilter(
  snapshot: IHeapSnapshot,
  value: number | string,
): {owner: number} | {error: string} {
  const text = String(value).trim().toLowerCase().replace(/^@/, '');
  if (text === 'shared') return {owner: SHARED};
  if (text === 'unattributed' || text === 'none') return {owner: UNATTRIBUTED};
  const node = snapshot.getNodeById(Number(text));
  if (node == null || !isNativeContext(node.name)) {
    return {
      error: `native_context "${value}" is not a NativeContext id, "shared" or "unattributed". memlab_native_contexts lists the ids.`,
    };
  }
  return {owner: node.nodeIndex};
}
