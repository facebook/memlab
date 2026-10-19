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
 * The standard statistics split of a heap snapshot, the one heap profilers
 * show next to a capture: native vs V8 heap, and within the V8 heap code,
 * strings, JS arrays and engine-internal ("system") objects.
 *
 * `extra_native_bytes` is native memory V8 accounts for but has no node for,
 * e.g. ArrayBuffer backing stores held outside the graph. It is part of the
 * total and of "native"; summing node sizes alone misses it, which
 * under-reports Wasm-, media- and canvas-heavy heaps.
 */
export interface HeapStatistics {
  /** Root retained size plus `extraNativeBytes`. */
  total: number;
  extraNativeBytes: number;
  native: {total: number; typedArrays: number};
  v8heap: {
    total: number;
    code: number;
    strings: number;
    jsArrays: number;
    system: number;
    other: number;
  };
}

const STRING_TYPES = new Set([
  'string',
  'concatenated string',
  'sliced string',
]);

/** `extra_native_bytes` from the snapshot header, or 0 when absent. */
export function extraNativeBytes(snapshot: IHeapSnapshot): number {
  const raw = (
    snapshot as unknown as {
      snapshot?: {snapshot?: {extra_native_bytes?: number}};
    }
  ).snapshot;
  const n = raw?.snapshot?.extra_native_bytes;
  return typeof n === 'number' && n > 0 ? n : 0;
}

/**
 * A JS array's size includes its elements store when the array is the
 * store's only holder; a shared store is counted where it is shared.
 */
function jsArraySize(node: IHeapNode): number {
  let size = node.self_size;
  const elements = node.findAnyReference(
    (e: IHeapEdge) => e.type === 'internal' && e.name_or_index === 'elements',
  )?.toNode;
  if (elements != null) {
    let holders = 0;
    elements.forEachReferrer(() => {
      holders++;
      if (holders > 1) return {stop: true};
    });
    if (holders === 1) size += elements.self_size;
  }
  return size;
}

const cache = new WeakMap<IHeapSnapshot, HeapStatistics>();

export function heapStatistics(snapshot: IHeapSnapshot): HeapStatistics {
  const hit = cache.get(snapshot);
  if (hit != null) return hit;
  const extra = extraNativeBytes(snapshot);
  let native = extra;
  let typedArrays = 0;
  let code = 0;
  let strings = 0;
  let jsArrays = 0;
  let system = 0;
  snapshot.nodes.forEach((node: IHeapNode) => {
    const size = node.self_size;
    const type = node.type;
    if (type === 'hidden') {
      system += size;
    } else if (type === 'native') {
      native += size;
      if (node.name === 'system / JSArrayBufferData') typedArrays += size;
    } else if (type === 'code') {
      code += size;
    } else if (STRING_TYPES.has(type)) {
      strings += size;
    } else if (type === 'object' && node.name === 'Array') {
      jsArrays += jsArraySize(node);
    }
  });
  const root = snapshot.nodes.get(0);
  const total = (root?.retainedSize ?? 0) + extra;
  const v8total = Math.max(0, total - native);
  const stats: HeapStatistics = {
    total,
    extraNativeBytes: extra,
    native: {total: native, typedArrays},
    v8heap: {
      total: v8total,
      code,
      strings,
      jsArrays,
      system,
      other: Math.max(0, v8total - code - strings - jsArrays - system),
    },
  };
  cache.set(snapshot, stats);
  return stats;
}
