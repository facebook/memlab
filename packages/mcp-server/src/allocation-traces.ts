/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapSnapshot} from '@memlab/core';

/**
 * Allocation stacks recorded with allocation tracking on (a heap timeline, or
 * any snapshot taken while `HeapProfiler.startTrackingHeapObjects({
 * trackAllocations: true })` was active). Every node then carries a
 * `trace_node_id` into `trace_tree`, a call tree whose nodes name a function
 * in `trace_function_infos`. Following a node's trace id up the tree gives the
 * stack that allocated it.
 */

export interface Frame {
  name: string;
  script: string;
  line: number;
  column: number;
}

interface TraceNode {
  functionIndex: number;
  parent: number;
}

export interface AllocationTraces {
  /** The stack for a trace node id, innermost frame first. */
  stack(traceNodeId: number, depth: number): Frame[];
}

interface RawTraces {
  snapshot: {
    meta: Record<string, unknown>;
    trace_function_count?: number;
  };
  strings: string[];
  trace_function_infos?: ArrayLike<number>;
  trace_tree?: unknown[];
}

const cache = new WeakMap<IHeapSnapshot, AllocationTraces | null>();

/** The snapshot's allocation traces, or null when it has none. */
export function allocationTraces(
  snapshot: IHeapSnapshot,
): AllocationTraces | null {
  if (cache.has(snapshot)) return cache.get(snapshot) ?? null;
  const raw = (snapshot as unknown as {snapshot?: RawTraces}).snapshot;
  const meta = raw?.snapshot?.meta;
  const infoFields = (meta?.trace_function_info_fields as string[]) ?? [];
  const treeFields = (meta?.trace_node_fields as string[]) ?? [];
  const infos = raw?.trace_function_infos;
  const tree = raw?.trace_tree;
  if (
    raw == null ||
    !(raw.snapshot.trace_function_count ?? 0) ||
    infos == null ||
    !Array.isArray(tree) ||
    infoFields.length === 0 ||
    treeFields.length === 0
  ) {
    cache.set(snapshot, null);
    return null;
  }

  const idOff = treeFields.indexOf('id');
  const fnOff = treeFields.indexOf('function_info_index');
  const childOff = treeFields.indexOf('children');
  const nameOff = infoFields.indexOf('name');
  const scriptOff = infoFields.indexOf('script_name');
  const lineOff = infoFields.indexOf('line');
  const colOff = infoFields.indexOf('column');
  // A layout without these fields would be read off the wrong slots and give
  // plausible-looking but wrong stacks; report no traces instead.
  if (
    [idOff, fnOff, childOff, nameOff, scriptOff, lineOff, colOff].some(
      o => o < 0,
    )
  ) {
    cache.set(snapshot, null);
    return null;
  }
  const stride = treeFields.length;
  const nodes = new Map<number, TraceNode>();
  // Iterative walk: the tree nests one array per level, and a deep call
  // tree would overflow a recursive one.
  const work: Array<{arr: unknown[]; parent: number}> = [
    {arr: tree, parent: 0},
  ];
  while (work.length > 0) {
    const {arr, parent} = work.pop() as {arr: unknown[]; parent: number};
    for (let i = 0; i + stride <= arr.length; i += stride) {
      const id = arr[i + idOff] as number;
      nodes.set(id, {functionIndex: arr[i + fnOff] as number, parent});
      const children = arr[i + childOff];
      if (Array.isArray(children) && children.length > 0) {
        work.push({arr: children, parent: id});
      }
    }
  }

  const fStride = infoFields.length;
  const frameCount = Math.floor(infos.length / fStride);
  // A malformed capture can name a function past the table: show it as
  // unknown rather than as a frame of undefined fields.
  const frame = (fi: number): Frame => {
    if (!(fi >= 0 && fi < frameCount)) {
      return {name: '(unknown function)', script: '', line: 0, column: 0};
    }
    const at = fi * fStride;
    return {
      name: raw.strings[infos[at + nameOff]] || '(anonymous)',
      script: raw.strings[infos[at + scriptOff]] ?? '',
      line: infos[at + lineOff] ?? 0,
      column: infos[at + colOff] ?? 0,
    };
  };

  const traces: AllocationTraces = {
    stack(traceNodeId: number, depth: number): Frame[] {
      const out: Frame[] = [];
      let id = traceNodeId;
      const seen = new Set<number>();
      while (id !== 0 && out.length < depth && !seen.has(id)) {
        seen.add(id);
        const n = nodes.get(id);
        if (n == null) break;
        const f = frame(n.functionIndex);
        if (f.name !== '(root)') out.push(f);
        id = n.parent;
      }
      return out;
    },
  };
  cache.set(snapshot, traces);
  return traces;
}

export function formatFrame(f: Frame): string {
  const where = f.script
    ? `${f.script.replace(/^.*\//, '')}${f.line > 0 ? `:${f.line}${f.column > 0 ? `:${f.column}` : ''}` : ''}`
    : '';
  return where ? `${f.name} (${where})` : f.name;
}
