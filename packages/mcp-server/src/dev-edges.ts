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
 * Edges that exist only in a development build or with devtools attached.
 *
 * Every dev-only check used to key on dev ROOTS: a global, the inspector's
 * console handles, a Fast Refresh registry. That misses the edges React DEV
 * threads through ordinary app objects. Measured on WhatsApp Web: detached
 * islands pinned through `WDSIcon (module scope).children -> _owner ->
 * _debugStack -> ChatImpl` were reported as production leaks by `leak_report`,
 * `detached_dom` and `island_doors` alike, because no dev root is on that path.
 *
 * These are refused as EDGES, not turned into sink nodes. `_owner` and
 * `_debugOwner` point at live fibers that the app reaches anyway; sinking the
 * target would mark the whole fiber tree dev-only.
 */

import type {IHeapEdge, IHeapNode} from '@memlab/core';
import {classifyModuleName} from './dev-modules.js';

/**
 * Globals installed by browser dev tools / extensions. Anything retained ONLY
 * through one of these would be garbage-collected in production.
 */
export const DEV_GLOBAL_EDGE_NAMES: ReadonlySet<string> = new Set([
  '__REACT_DEVTOOLS_GLOBAL_HOOK__',
  '__REACT_DEVTOOLS_ATTACH__',
  '__REDUX_DEVTOOLS_EXTENSION__',
  '__REDUX_DEVTOOLS_EXTENSION_COMPAT__',
  '__VUE_DEVTOOLS_GLOBAL_HOOK__',
  '__MOBX_DEVTOOLS_GLOBAL_HOOK__',
  '__APOLLO_DEVTOOLS_GLOBAL_HOOK__',
  '__RECOIL_DEVTOOLS_EXTENSION__',
  'Debug', // window.Debug — common debugging handle (e.g. WhatsApp Web)
]);

const DEV_EDGE_REASONS: ReadonlyMap<string, string> = new Map([
  ['_debugOwner', 'React DEV fiber owner (_debugOwner)'],
  ['_debugStack', 'React DEV owner stack (_debugStack)'],
  ['_debugTask', 'React DEV console task (_debugTask)'],
  ['_debugInfo', 'React DEV debug info (_debugInfo)'],
  ['_debugHookTypes', 'React DEV hook list (_debugHookTypes)'],
  ['$RefreshSig$', 'React Fast Refresh ($RefreshSig$)'],
  ['$RefreshReg$', 'React Fast Refresh ($RefreshReg$)'],
  ['allSignaturesByType', 'React Fast Refresh registry (allSignaturesByType)'],
  ['allFamiliesByID', 'React Fast Refresh registry (allFamiliesByID)'],
  ['allFamiliesByType', 'React Fast Refresh registry (allFamiliesByType)'],
  [
    'updatedFamiliesByType',
    'React Fast Refresh registry (updatedFamiliesByType)',
  ],
]);

// Markers present on a React DEV element and absent from a production one.
const DEV_ELEMENT_MARKERS = new Set([
  '_store',
  '_debugInfo',
  '_debugStack',
  '_debugTask',
]);

const CONSOLE_HANDLE_EDGE_RE = /DevTools console/i;
const MODULE_NAME_SHAPE = /^[A-Z][A-Za-z0-9_$]{3,}$/;
const moduleReasonCache = new Map<string, string | null>();

function moduleReason(name: string): string | null {
  const cached = moduleReasonCache.get(name);
  if (cached !== undefined) return cached;
  let reason: string | null = null;
  if (MODULE_NAME_SHAPE.test(name)) {
    const byName = classifyModuleName(name);
    if (byName.dev) reason = `dev-only module ${name} (${byName.why})`;
  }
  if (moduleReasonCache.size < 100_000) moduleReasonCache.set(name, reason);
  return reason;
}

function isGlobalObject(node: IHeapNode): boolean {
  return (
    node.name.startsWith('Window') ||
    node.name === 'global' ||
    node.name === 'globalThis'
  );
}

function hasDevElementMarker(holder: IHeapNode): boolean {
  for (const e of holder.references) {
    if (DEV_ELEMENT_MARKERS.has(String(e.name_or_index))) return true;
  }
  return false;
}

/**
 * Why an edge exists only in a DEV build / with devtools attached, or null.
 *
 * `_owner` is the one name that needs its holder: React 18 production elements
 * carry it too, so it only counts when the element also has a DEV marker.
 */
export function devEdgeReason(
  edgeName: string | number | undefined,
  holder: IHeapNode | null,
): string | null {
  if (typeof edgeName !== 'string' || edgeName === '') return null;
  const fixed = DEV_EDGE_REASONS.get(edgeName);
  if (fixed != null) return fixed;
  if (
    DEV_GLOBAL_EDGE_NAMES.has(edgeName) &&
    holder != null &&
    isGlobalObject(holder)
  ) {
    return `dev/extension global ${edgeName}`;
  }
  if (edgeName === '_owner') {
    return holder != null && hasDevElementMarker(holder)
      ? 'React DEV element owner (_owner)'
      : null;
  }
  if (CONSOLE_HANDLE_EDGE_RE.test(edgeName)) {
    return 'DevTools console handle';
  }
  const c = edgeName.charCodeAt(0);
  if (c >= 65 && c <= 90) return moduleReason(edgeName);
  return null;
}

export function isDevEdge(edge: IHeapEdge, holder: IHeapNode): boolean {
  return devEdgeReason(edge.name_or_index, holder) != null;
}

export type ProductionPath =
  | {kind: 'found'; steps: Array<{node: IHeapNode; edgeName: string}>}
  | {kind: 'none'}
  | {kind: 'capped'};

/**
 * Shortest GC-root path to `target` that uses no dev edge and no weak edge,
 * found by walking referrers backwards from the target. `none` means every
 * path runs through a dev edge: the object does not exist in production.
 * Root-first order, each step's `edgeName` being the edge out of that node.
 */
export function shortestPathAvoidingDevEdges(
  target: IHeapNode,
  maxVisited = 500_000,
): ProductionPath {
  // node id -> the next node toward the target, and the edge into it.
  const toward = new Map<number, {to: IHeapNode; edgeName: string} | null>();
  toward.set(target.id, null);
  let frontier: IHeapNode[] = [target];
  while (frontier.length > 0) {
    const next: IHeapNode[] = [];
    for (const node of frontier) {
      if (
        (node.type === 'synthetic' && !node.name.includes('Detached')) ||
        node.id <= 3
      ) {
        const steps: Array<{node: IHeapNode; edgeName: string}> = [];
        let cur: IHeapNode = node;
        let link = toward.get(cur.id);
        while (link != null) {
          steps.push({node: cur, edgeName: link.edgeName});
          cur = link.to;
          link = toward.get(cur.id);
        }
        steps.push({node: cur, edgeName: ''});
        return {kind: 'found', steps};
      }
      for (const edge of node.referrers) {
        if (edge.type === 'weak') continue;
        const from = edge.fromNode;
        if (from == null || toward.has(from.id)) continue;
        if (devEdgeReason(edge.name_or_index, from) != null) continue;
        toward.set(from.id, {to: node, edgeName: String(edge.name_or_index)});
        if (toward.size > maxVisited) return {kind: 'capped'};
        next.push(from);
      }
    }
    frontier = next;
  }
  return {kind: 'none'};
}
