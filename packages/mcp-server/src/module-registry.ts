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
 * Module records found by shape, so module state can be reached on a minified
 * build.
 *
 * On a minified bundle the registry's own variable is mangled (it is a
 * closure-captured `o`, not `modulesMap`), but each module record keeps its
 * property names: `id` holds the module name as a string, and `factory`,
 * `exports` and `defaultExport` survive. So a record is any object with an
 * `id` string and a `factory` or `defaultExport` slot, whatever the registry
 * is called. (`factory` alone is not enough: it is dropped once the module
 * has run.)
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';

export interface ModuleRecord {
  name: string;
  record: IHeapNode;
  exports: IHeapNode | null;
  defaultExport: IHeapNode | null;
}

const cache = new WeakMap<IHeapSnapshot, Map<string, ModuleRecord>>();

function isValue(node: IHeapNode): boolean {
  return node.type === 'object' || node.type === 'closure';
}

export function moduleRecords(
  snapshot: IHeapSnapshot,
): Map<string, ModuleRecord> {
  const cached = cache.get(snapshot);
  if (cached != null) return cached;
  const out = new Map<string, ModuleRecord>();
  snapshot.nodes.forEach(node => {
    if (node.type !== 'object') return;
    let name: string | null = null;
    let isRecord = false;
    let exports: IHeapNode | null = null;
    let defaultExport: IHeapNode | null = null;
    for (const e of node.references) {
      if (e.type !== 'property') continue;
      const key = e.name_or_index;
      if (key === 'id') {
        if (e.toNode.type === 'string') name = e.toNode.name;
      } else if (key === 'factory') {
        isRecord = true;
      } else if (key === 'exports') {
        if (isValue(e.toNode)) exports = e.toNode;
      } else if (key === 'defaultExport') {
        isRecord = true;
        if (isValue(e.toNode)) defaultExport = e.toNode;
      }
    }
    if (name == null || !isRecord) return;
    // Heap order is not load order: a populated record wins over a
    // placeholder for the same name, whichever is visited first.
    const prev = out.get(name);
    if (
      prev != null &&
      ((prev.exports ?? prev.defaultExport) != null ||
        (exports ?? defaultExport) == null)
    ) {
      return;
    }
    out.set(name, {name, record: node, exports, defaultExport});
  });
  cache.set(snapshot, out);
  return out;
}

/**
 * The module's top-level scope(s): the closure contexts of the nearest
 * functions its exports reach (an exported function, a method of an exported
 * object, a prototype method of an exported instance). Variable names in them
 * are mangled on a minified build.
 */
export function moduleScopes(rec: ModuleRecord): IHeapNode[] {
  const MAX_VISITED = 500;
  const scopes = new Map<number, IHeapNode>();
  const visited = new Set<number>();
  let frontier = [rec.exports, rec.defaultExport].filter(
    (n): n is IHeapNode => n != null,
  );
  for (let depth = 0; depth <= 3 && frontier.length > 0; depth++) {
    const next: IHeapNode[] = [];
    for (const node of frontier) {
      if (visited.has(node.id) || visited.size >= MAX_VISITED) continue;
      // Object.prototype's methods are builtins shared by every module.
      if (node.name.startsWith('Object (prototype)')) continue;
      visited.add(node.id);
      for (const e of node.references) {
        const key = String(e.name_or_index);
        const to = e.toNode;
        // Builtins close over the native context, which is not module state.
        if (
          node.type === 'closure' &&
          key === 'context' &&
          to.name.startsWith('system / Context')
        ) {
          scopes.set(to.id, to);
        } else if (
          (e.type === 'property' || key === '__proto__') &&
          (to.type === 'closure' || to.type === 'object')
        ) {
          next.push(to);
        }
      }
    }
    // The nearest functions are the module's own; going deeper reaches
    // prototype methods that may close over other modules.
    if (scopes.size > 0) break;
    frontier = next;
  }
  return [...scopes.values()];
}

export interface ScopeVar {
  variable: string;
  node: IHeapNode;
}

export function moduleScopeVars(rec: ModuleRecord): ScopeVar[] {
  const out: ScopeVar[] = [];
  const seen = new Set<number>();
  for (const scope of moduleScopes(rec)) {
    for (const e of scope.references) {
      if (e.type !== 'context') continue;
      if (seen.has(e.toNode.id)) continue;
      seen.add(e.toNode.id);
      out.push({variable: String(e.name_or_index), node: e.toNode});
    }
  }
  return out;
}

/**
 * A module's state by name: an export property, then a top-level variable of
 * that name (dev builds), then — when `className` is given — the only
 * top-level variable of that class (minified builds, where the name is gone).
 */
export function moduleExportProp(
  snapshot: IHeapSnapshot,
  moduleName: string,
  prop: string,
  className?: string,
): {node: IHeapNode; via: 'export' | 'scope' | 'class'} | null {
  const rec = moduleRecords(snapshot).get(moduleName);
  if (rec == null) return null;
  for (const value of [rec.exports, rec.defaultExport]) {
    if (value == null) continue;
    for (const e of value.references) {
      if (e.type === 'property' && e.name_or_index === prop) {
        return {node: e.toNode, via: 'export'};
      }
    }
  }
  const vars = moduleScopeVars(rec);
  const byName = vars.find(v => v.variable === prop);
  if (byName != null) return {node: byName.node, via: 'scope'};
  if (className != null) {
    const ofClass = vars.filter(v => v.node.name === className);
    if (ofClass.length === 1) return {node: ofClass[0].node, via: 'class'};
    if (ofClass.length > 1) {
      // Ambiguous is not absent: a null here would read as a 0 downstream.
      throw new Error(
        `${moduleName} has ${ofClass.length} top-level ${className} variables ` +
          `(${ofClass.map(v => `${v.variable} @${v.node.id}`).join(', ')}); ` +
          `pick one from helpers.module('${moduleName}').scope`,
      );
    }
  }
  return null;
}
