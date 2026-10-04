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

import type {IHeapEdge, IHeapNode, IHeapSnapshot} from '@memlab/core';
import {ScanTimeoutError, tickAnalysis} from './analysis-budget.js';
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

const MODULE_FACTORY_PREFIX = '$module_';
const devModuleCache = new WeakMap<IHeapSnapshot, Map<number, string>>();

/**
 * Module records, factories, exports and top-level scopes of dev-only
 * modules, by node index.
 *
 * The registry does not always name its entries: a dictionary-mode
 * `modulesMap` reaches a module through `.properties -> (object properties)
 * .166078`, so the edge-name check never sees `BrowserToolsInteractionTracing
 * Interop` and a Map in that module read as production-reachable. The record
 * is found from its factory closure, `$module_<Name>`, through the `factory`
 * edge. Computed once per snapshot.
 */
export function devModuleNodes(snapshot: IHeapSnapshot): Map<number, string> {
  const cached = devModuleCache.get(snapshot);
  if (cached != null) return cached;
  const out = new Map<number, string>();
  snapshot.nodes.forEach(node => {
    if (node.type !== 'closure') return;
    if (!node.name.startsWith(MODULE_FACTORY_PREFIX)) return;
    const name = node.name.slice(MODULE_FACTORY_PREFIX.length);
    const reason = moduleReason(name);
    if (reason == null) return;
    out.set(node.nodeIndex, reason);
    for (const e of node.referrers) {
      if (String(e.name_or_index) !== 'factory') continue;
      const record = e.fromNode;
      out.set(record.nodeIndex, reason);
      // The module's exports and the scope its exported closures share.
      // Production code that ends up holding a closure from that scope — a
      // dev module subscribing a callback to a production observer — only
      // does so because the dev module ran.
      for (const re of record.references) {
        const key = String(re.name_or_index);
        if (key !== 'exports' && key !== 'defaultExport') continue;
        const exp = re.toNode;
        if (exp.id <= 3 || exp.type !== 'object') continue;
        out.set(exp.nodeIndex, reason);
        for (const pe of exp.references) {
          if (pe.type !== 'property' || pe.toNode.type !== 'closure') continue;
          for (const ce of pe.toNode.references) {
            if (String(ce.name_or_index) === 'context') {
              out.set(ce.toNode.nodeIndex, reason);
            }
          }
        }
      }
    }
  });
  devModuleCache.set(snapshot, out);
  return out;
}

/** Why following `edge` from `holder` leaves production, or null. */
export function devStepReason(
  edge: IHeapEdge,
  holder: IHeapNode,
  devModules: Map<number, string>,
): string | null {
  return (
    devEdgeReason(edge.name_or_index, holder) ??
    devModules.get(edge.toNode.nodeIndex) ??
    null
  );
}

export type ProductionPath =
  | {kind: 'found'; steps: Array<{node: IHeapNode; edgeName: string}>}
  | {kind: 'none'}
  | {kind: 'undecided'};

interface ProductionBfs {
  parent: Int32Array;
  queue: Int32Array;
  head: number;
  tail: number;
}

// One BFS per snapshot, resumed by each lookup rather than restarted:
// cache_analysis asks for a path per dev-flagged row, and a fresh O(V+E) walk
// (plus two n-sized arrays) per row made the table O(rows * (V+E)).
const productionBfsCache = new WeakMap<IHeapSnapshot, ProductionBfs>();

function productionBfs(snapshot: IHeapSnapshot): ProductionBfs {
  const cached = productionBfsCache.get(snapshot);
  if (cached != null) return cached;
  const n = snapshot.nodes.length;
  const bfs: ProductionBfs = {
    parent: new Int32Array(n).fill(-1),
    queue: new Int32Array(n),
    head: 0,
    tail: 0,
  };
  snapshot.nodes.forEach(node => {
    if (node.type !== 'synthetic' && node.id > 3) return;
    if (node.name.includes('Detached')) return;
    bfs.parent[node.nodeIndex] = node.nodeIndex;
    bfs.queue[bfs.tail++] = node.nodeIndex;
  });
  productionBfsCache.set(snapshot, bfs);
  return bfs;
}

/**
 * Shortest GC-root path to `target` that uses no dev edge and no weak edge.
 * `none` means every path runs through a dev edge: the object does not exist
 * in production; `undecided` means the analysis budget ran out first. Root-
 * first order, each step's `edgeName` being the edge out of that node.
 *
 * Forward BFS from the synthetic roots, one O(V+E) pass. Walking referrers
 * back from the target was tried first and gave up at 200,000 nodes on a Map
 * in a module scope: every closure of the module references that context, so
 * the backward fan-in explodes long before a root is reached.
 */
export function shortestPathAvoidingDevEdges(
  snapshot: IHeapSnapshot,
  target: IHeapNode,
): ProductionPath {
  const devModules = devModuleNodes(snapshot);
  const bfs = productionBfs(snapshot);
  const {parent, queue} = bfs;
  const targetIdx = target.nodeIndex;
  try {
    // A budget abort leaves the state consistent (it throws before the
    // dequeue), so the next lookup resumes where this one stopped.
    while (bfs.head < bfs.tail && parent[targetIdx] < 0) {
      tickAnalysis();
      const from = snapshot.nodes.get(queue[bfs.head++]);
      if (from == null) continue;
      from.forEachReference((edge: IHeapEdge) => {
        const to = edge.toNode;
        if (parent[to.nodeIndex] >= 0 || edge.type === 'weak') return;
        if (devStepReason(edge, from, devModules) != null) return;
        parent[to.nodeIndex] = from.nodeIndex;
        queue[bfs.tail++] = to.nodeIndex;
      });
    }
  } catch (err) {
    if (err instanceof ScanTimeoutError) return {kind: 'undecided'};
    throw err;
  }
  if (parent[targetIdx] < 0) return {kind: 'none'};
  const chain: IHeapNode[] = [];
  for (let idx = targetIdx; ; idx = parent[idx]) {
    const node = snapshot.nodes.get(idx);
    if (node == null) break;
    chain.push(node);
    if (parent[idx] === idx) break;
  }
  chain.reverse();
  const steps = chain.map((node, i) => {
    const next = chain[i + 1];
    let edgeName = '';
    if (next != null) {
      for (const e of node.references) {
        if (
          e.toNode.nodeIndex === next.nodeIndex &&
          e.type !== 'weak' &&
          devStepReason(e, node, devModules) == null
        ) {
          edgeName = String(e.name_or_index);
          break;
        }
      }
    }
    return {node, edgeName};
  });
  return {kind: 'found', steps};
}

/** `root .edge → Name @id …`, eliding the middle of a long path. */
export function formatProductionPath(
  steps: Array<{node: IHeapNode; edgeName: string}>,
  maxHops = 12,
): string {
  const hops = steps.map((st, i) =>
    i === 0
      ? st.node.name
      : `.${steps[i - 1].edgeName} → ${st.node.name} @${st.node.id}`,
  );
  if (hops.length <= maxHops) return hops.join(' ');
  const head = Math.floor(maxHops / 3);
  const tail = maxHops - head;
  return [
    ...hops.slice(0, head),
    `… ${hops.length - maxHops} more …`,
    ...hops.slice(-tail),
  ].join(' ');
}
