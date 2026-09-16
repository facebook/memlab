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

export const CALLBACK_PROPS: ReadonlySet<string> = new Set([
  'callback',
  'fn',
  'handler',
  'listener',
]);

export const CONTEXT_PROPS: ReadonlySet<string> = new Set([
  'context',
  'ctx',
  'this',
  'target',
  'scope',
]);

export interface Listener {
  callbackId: number;
  contextId: number;
}

export interface StructuralRegistry {
  /** The object that OWNS the container (may be the container itself). */
  hostId: number;
  hostName: string;
  /** The object whose properties are eventName -> Array<listener>. */
  containerId: number;
  /** Property name on the host that reaches the container, if one was found. */
  containerProp: string | null;
  events: Array<{name: string; listeners: Listener[]}>;
  totalListeners: number;
}

/**
 * Extract `{callback, context}` listeners (or bare closures) from an Array node.
 *
 * Shared with `memlab_event_registry`, which is the reason this lives in its own
 * module: the two listener tools disagreed on a measured capture — one reported
 * 762 hosts / 11,016 listeners and the other "no accumulation found" — because
 * only one of them could recognise the population. One definition, two callers.
 */
export function listenersFromArray(arr: IHeapNode): Listener[] {
  const out: Listener[] = [];
  for (const e of arr.references) {
    if (e.type !== 'element') continue;
    const entry = e.toNode;
    if (entry.id <= 3) continue;
    if (entry.type === 'closure') {
      out.push({callbackId: entry.id, contextId: 0});
    } else if (entry.type === 'object') {
      let cb = 0;
      let ctx = 0;
      for (const pe of entry.references) {
        const pn = String(pe.name_or_index);
        if (CALLBACK_PROPS.has(pn)) cb = pe.toNode.id;
        else if (CONTEXT_PROPS.has(pn)) ctx = pe.toNode.id;
      }
      if (cb > 0) out.push({callbackId: cb, contextId: ctx});
    }
  }
  return out;
}

/**
 * Find emitter registries by SHAPE rather than by container property name.
 *
 * Why this exists: a name-keyed scan cannot work on a minified build. On a real
 * capture the container of a live emitter was reached through property `$1` —
 * walked as
 * `EmitterSubscription -> Array -> property 'change' on Object -> property '$1'`.
 * No enumerable list of names can ever contain `$1`, and matching it on sight
 * would fire on everything. The shape — an object whose property VALUES are
 * arrays whose ELEMENTS are listener-shaped — survives minification, because
 * the event names themselves are data, not identifiers.
 *
 * `minEvents` is the number of distinct event arrays a container must hold. 2 is
 * the useful floor: a single-array object is usually not a registry.
 */
export const DEFAULT_MIN_REGISTRY_EVENTS = 2;

export function findStructuralRegistries(
  snapshot: IHeapSnapshot,
  minEvents: number,
  onTick?: () => void,
): StructuralRegistry[] {
  const out: StructuralRegistry[] = [];
  snapshot.nodes.forEach(node => {
    onTick?.();
    if (node.id <= 3 || node.type !== 'object') return;
    let totalListeners = 0;
    const events: Array<{name: string; listeners: Listener[]}> = [];
    for (const edge of node.references) {
      if (edge.type !== 'property') continue;
      const target = edge.toNode;
      if (target.type !== 'object' || target.name !== 'Array') continue;
      const listeners = listenersFromArray(target);
      if (listeners.length === 0) continue;
      events.push({name: String(edge.name_or_index), listeners});
      totalListeners += listeners.length;
    }
    if (events.length < minEvents) return;
    out.push({
      hostId: node.id,
      hostName: node.name,
      containerId: node.id,
      containerProp: findOwningProperty(node),
      events,
      totalListeners,
    });
  });
  return out;
}

/**
 * The property name a container is reached through, when there is exactly one
 * such referrer. Reported rather than matched on: on a minified build this is
 * the thing that tells the reader WHY the named scan missed it (`$1`), which is
 * the difference between "no accumulation" and "a container I cannot name".
 */
export function findOwningProperty(container: IHeapNode): string | null {
  for (const e of container.referrers) {
    if (e.type === 'property') return String(e.name_or_index);
  }
  return null;
}
