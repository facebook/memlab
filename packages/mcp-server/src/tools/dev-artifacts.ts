/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapEdge, IHeapNode, IHeapSnapshot} from '@memlab/core';
import memlabCore from '@memlab/core';
const {utils, NumericSet} = memlabCore;
import {z} from 'zod';
import {getSnapshot, getSnapshotMetadata} from '../heap-state.js';
import {
  describeSkipped,
  formatBytes,
  formatNumber,
  markdownTable,
  truncateNodeName,
  errorResult,
  toolResult,
} from '../utils.js';
import {
  isReactRefreshSignatureShape,
  REACT_REFRESH_REGISTRY_EDGE_NAMES,
  REACT_REFRESH_SIGNATURE_GATE_PROP,
} from '../artifact-classes.js';

// Globals installed by browser dev tools / extensions. Anything retained ONLY
// through one of these would be garbage-collected in production — it's a
// profiling artifact, not a real leak (Feedback round 2 §6).
const DEV_GLOBAL_EDGE_NAMES = new Set([
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

// React Fast Refresh (react-refresh) bookkeeping, installed on the global by the
// DEV-only runtime. `$RefreshSig$` / `$RefreshReg$` close over the refresh
// runtime's module-scope registries — `allFamiliesByID`, `allSignaturesByType`,
// and the family/signature maps behind them — which hold every component type
// and hook signature the page has ever compiled, plus the fibers and DOM those
// types transitively reach.
//
// Neither the globals nor the registries exist in a production build, but the
// chain roots at the real Window (not at a devtools hook or the inspector), so
// every earlier check classified the whole family `production`. Measured cost of
// getting this wrong: on one WA Web round ~93 MB of a 137.7 MB "detached DOM
// leak" was Fast Refresh retention, and a later round reported a 16,375-entry /
// 1.2 MB `allFamiliesByID` Map as a production cache-like collection. Both were
// dev-build-only.
const REACT_REFRESH_GLOBAL_EDGE_NAMES = new Set([
  '$RefreshSig$',
  '$RefreshReg$',
]);

// Detecting Fast Refresh by its GLOBALS alone is not enough, and the gap is
// large rather than marginal. `$RefreshSig$` / `$RefreshReg$` are thin wrappers;
// the registries they talk to live in the refresh runtime's module scope and are
// reachable only through compiled-code constant pools
// (`system/TrustedWeakFixedArray`, `system/InstructionStream`), so the globals
// DOMINATE almost nothing and the registries stay classified `production`.
//
// Measured on a WhatsApp Web round: dev_artifacts reported
// `React Fast Refresh registry ($RefreshSig$) x2` and attributed 1.4 KB, while
// in the same snapshot the `allSignaturesByType` WeakMap's backing table alone
// was 4,096 KB and `allFamiliesByID` held 16,367 entries / 1.2 MB. The 4 MB was
// filed as a production optimization opportunity before being withdrawn.
//
// So match the registries by CONTENT as well, independent of retainer path:
//
//   1. the registry container, by the edge name that binds it in module scope;
//   2. the per-type signature record react-refresh stores via
//      `setSignature(type, key, forceReset, getCustomHooks)`.
//
// Both signatures live in `artifact-classes`, which is where every
// content-matched non-production family is registered.

/**
 * True when `node` is a react-refresh signature record. Callers gate on the
 * rare property first; this confirms the rest.
 */
function isReactRefreshSignatureRecord(node: IHeapNode): boolean {
  const propNames: string[] = [];
  for (const edge of node.references) {
    if (edge.type !== 'property') continue;
    propNames.push(String(edge.name_or_index));
  }
  return isReactRefreshSignatureShape(propNames);
}

// The automation/devtools *bridge* injected into the page by a CDP-driven
// harness (the browser MCP plugin, a browser-tools extension, Puppeteer helper
// bundles). This is the harness observing the app, not the app.
//
// Two independent signatures, both observed on real hunts:
//   - `TOOL_DEFINITIONS`: the bridge's tool manifest, reached through its
//     listener closure's scope chain. On one run it held 64 `.description`
//     strings that `intern_opportunities` then reported as the single largest
//     interning opportunity in the heap.
//   - bridge entry points by name (`getDevToolBridge`,
//     `BrowserToolsSuspenseInterop`), which show up as multi-MB `production`
//     retainers in `dev_artifacts`' own table.
//
// Like `_debugStack` this is found by scanning edges rather than global roots,
// because the bridge is reached from ordinary app-side listeners.
const HARNESS_EDGE_NAMES = new Set(['TOOL_DEFINITIONS']);
const HARNESS_NODE_NAME_RE =
  /getDevToolBridge|BrowserToolsSuspenseInterop|__BROWSER_TOOLS_|__PUPPETEER_/;

const DEV_NODE_NAME_RE = /__REACT_DEVTOOLS|DEVTOOLS_GLOBAL_HOOK|ReactDevTools/;

// Dev-tools BRIDGES are not reached through a window global, so none of the
// checks above see them: the bridge module sits in the app's own module
// registry and the objects it accumulates (stanza logs, route history, command
// registries) root at the real Window. A dev-build bridge that records one
// entry per network message accumulates for as long as the tab is open — on one
// measured session 15,582 records / 3.05 MB, still growing while idle — and was
// reported as production memory.
const DEV_BRIDGE_NODE_NAME_RE =
  /DevToolsBridge|DevToolBridge|__DEVTOOLS_BRIDGE__/i;

/**
 * Deployment-specific artifact roots, so a repo can teach this tool about a
 * dev-only global or module the OSS package cannot know about, instead of the
 * family being silently counted as production memory.
 *
 *   MEMLAB_DEV_ARTIFACT_GLOBALS=myDebugHook,__MY_DEVTOOLS__
 *   MEMLAB_DEV_ARTIFACT_NODE_PATTERN=MyAppDebugBridge|MyProfiler
 */
function extraDevGlobalNames(): Set<string> {
  const raw = process.env.MEMLAB_DEV_ARTIFACT_GLOBALS;
  if (raw == null || raw.trim() === '') return new Set();
  return new Set(
    raw
      .split(',')
      .map(n => n.trim())
      .filter(n => n.length > 0),
  );
}

function extraDevNodePattern(): RegExp | null {
  const raw = process.env.MEMLAB_DEV_ARTIFACT_NODE_PATTERN;
  if (raw == null || raw.trim() === '') return null;
  try {
    return new RegExp(raw, 'i');
  } catch {
    // A malformed pattern must not take the whole tool down; it is reported by
    // the explain output instead.
    return null;
  }
}

// Blink accessibility caches. Under CDP-driven automation the a11y tree is
// materialized (and browser_take_snapshot inflates it further), so this native
// cache balloons and co-retains detached DOM — automation-inflated retention
// that is not present at that scale in a normal user session, so it should not
// be counted toward a production leak total (Feedback: WA Web hunts §A).
const AX_NODE_NAME_RE =
  /AXObjectCache|AXNodeObject|AXDirtyObject|AXComputedObject|blink::AX/;

// CDP / DevTools inspector retention. When DevTools — or a CDP-driven
// automation session (Puppeteer / the browser MCP) — is attached, any object
// passed to console.log (or a dev-build devConsole) is held by the inspector
// via edges on the "(Global handles)" synthetic node named ".../ DevTools
// console". Such an object, and any subtree it pins (e.g. a logged
// `{node}` keeping a detached DOM tree alive), would be garbage-collected in a
// real user session with DevTools closed, so retention ONLY through them is a
// measurement artifact, not a production leak. `dev_artifacts` previously
// missed this because it only knew about dev globals and the a11y cache, which
// caused console-retained detached DOM to be mis-reported as production-real
// (Feedback round 3 §A).
const GLOBAL_HANDLES_NODE_NAME = '(Global handles)';
const CONSOLE_HANDLE_EDGE_RE = /DevTools console/i;

// React DEV-build owner stacks. In a development build React attaches
// `_debugStack` (a captured `Error`) to fibers. That Error's `ErrorStackData`
// holds the captured stack-frame array, which holds whatever closures were on
// the stack — commonly the `batchedUpdates` closure whose scope still refers to
// the handler's `nativeEvent`, which in turn pins the DOM subtree that was being
// unmounted. The result is a detached subtree retained entirely by DEV-only
// bookkeeping.
//
// This family is invisible to the checks above because the chain is rooted at a
// LIVE DOM element's fiber, not at a dev global or the inspector — so it was
// classified `production` and read as a genuine unmount leak. It is production-
// safe (`_debugStack` does not exist in a production React build) and, because
// it hangs off whatever handler was running, it fires on ANY synthetic-click
// hammer that unmounts a subtree.
//
// Marking the Error itself as a dev root is enough: the existing dev-only
// reachability pass then attributes the whole ErrorStackData -> frames ->
// closure -> nativeEvent -> detached-subtree chain to it.
const REACT_DEBUG_STACK_EDGE_NAMES = new Set(['_debugStack', '_debugTask']);

export interface DevRoots {
  // dev-root node id -> the global name it is installed under
  byId: Map<number, string>;
  // dev-root node id -> which family of artifact it belongs to, for the
  // per-source breakdown in the summary.
  categoryById: Map<number, DevRootCategory>;
}

export type DevRootCategory =
  | 'console'
  | 'a11y'
  | 'devGlobal'
  | 'reactDebugStack'
  | 'reactFastRefresh'
  | 'harness';

const CATEGORY_LABEL: Record<DevRootCategory, string> = {
  console: 'DevTools console (CDP inspector)',
  a11y: 'a11y / CDP automation cache',
  devGlobal: 'dev/extension global',
  reactDebugStack: 'React DEV owner stack (_debugStack)',
  reactFastRefresh: 'React Fast Refresh registry ($RefreshSig$)',
  harness: 'automation/devtools bridge (test harness)',
};

/**
 * One-line summary of the dev/automation roots present, as counts per family.
 *
 * The full list was printed on every call and is unbounded: each Blink a11y
 * object and each bridge export is its own root, so a measured WhatsApp Web run
 * spent ~1,500 tokens per call on a single comma-separated line of names, and an
 * Ads Manager run repeated an entire multi-sentence React warning inside it.
 * Nothing downstream keyed on the individual names — the reader needs to know
 * WHICH FAMILIES are present, which is what the categories already encode.
 * `show_roots: true` restores the full list for the rare case of chasing one
 * specific root.
 */
export function summarizeDevRoots(devRoots: DevRoots, showAll = false): string {
  if (devRoots.byId.size === 0) return 'none';
  if (showAll) {
    return [...new Set(devRoots.byId.values())].join(', ');
  }
  const byCat = new Map<DevRootCategory, number>();
  let uncategorized = 0;
  for (const id of devRoots.byId.keys()) {
    const cat = devRoots.categoryById.get(id);
    if (cat == null) {
      uncategorized++;
      continue;
    }
    byCat.set(cat, (byCat.get(cat) ?? 0) + 1);
  }
  const parts = [...byCat.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `${CATEGORY_LABEL[cat]} ×${n}`);
  if (uncategorized > 0) parts.push(`other ×${uncategorized}`);
  return `${devRoots.byId.size} root(s) — ${parts.join(', ')}`;
}

/**
 * Find the dev/extension "root" objects: the targets of dev-global edges on
 * the Window/global object, plus any node whose own name marks it as a
 * devtools hook.
 */
export function collectDevRoots(snapshot: IHeapSnapshot): DevRoots {
  const byId = new Map<number, string>();
  const categoryById = new Map<number, DevRootCategory>();
  const extraGlobals = extraDevGlobalNames();
  const extraNodeRe = extraDevNodePattern();
  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;
    // Bridges and deployment-specific dev modules are matched by NODE name:
    // they are not hung off a window global, so the edge-name checks below
    // never see them.
    if (
      DEV_BRIDGE_NODE_NAME_RE.test(node.name) ||
      (extraNodeRe != null && extraNodeRe.test(node.name))
    ) {
      byId.set(
        node.id,
        `${node.name} (dev-tools bridge; absent in production)`,
      );
      categoryById.set(node.id, 'devGlobal');
    }
    const isGlobal =
      node.name.startsWith('Window ') ||
      node.name === 'global' ||
      node.name === 'globalThis';
    if (isGlobal) {
      for (const edge of node.references) {
        const eName = String(edge.name_or_index);
        if (
          (DEV_GLOBAL_EDGE_NAMES.has(eName) || extraGlobals.has(eName)) &&
          edge.toNode.id > 3
        ) {
          byId.set(edge.toNode.id, eName);
          categoryById.set(edge.toNode.id, 'devGlobal');
        }
        if (REACT_REFRESH_GLOBAL_EDGE_NAMES.has(eName) && edge.toNode.id > 3) {
          byId.set(
            edge.toNode.id,
            `${eName} (React Fast Refresh; absent in production builds)`,
          );
          categoryById.set(edge.toNode.id, 'reactFastRefresh');
        }
      }
    }
    // Objects held only by the attached inspector's console (CDP global
    // handles named ".../ DevTools console"). Mark just those targets — NOT the
    // whole (Global handles) node, which also holds legitimate native/global
    // handles for real app objects.
    if (node.name === GLOBAL_HANDLES_NODE_NAME) {
      for (const edge of node.references) {
        if (
          CONSOLE_HANDLE_EDGE_RE.test(String(edge.name_or_index)) &&
          edge.toNode.id > 3
        ) {
          byId.set(
            edge.toNode.id,
            'DevTools console (CDP inspector-retained; GC-eligible with DevTools closed)',
          );
          categoryById.set(edge.toNode.id, 'console');
        }
      }
    }
    // React DEV owner stacks hang off fibers, which are reachable from LIVE
    // DOM nodes — so they are found by scanning edges, not global roots. The
    // automation bridge is reached the same way, from app-side listeners.
    for (const edge of node.references) {
      const eName = String(edge.name_or_index);
      if (REACT_DEBUG_STACK_EDGE_NAMES.has(eName) && edge.toNode.id > 3) {
        byId.set(
          edge.toNode.id,
          'React DEV owner stack (_debugStack; absent in production builds)',
        );
        categoryById.set(edge.toNode.id, 'reactDebugStack');
      }
      if (HARNESS_EDGE_NAMES.has(eName) && edge.toNode.id > 3) {
        byId.set(
          edge.toNode.id,
          `${eName} (automation/devtools bridge injected by the harness)`,
        );
        categoryById.set(edge.toNode.id, 'harness');
      }
      // Fast Refresh registries bound in the refresh runtime's module scope.
      // Matched by edge name rather than by retainer path, because the path
      // runs through compiled-code constant pools that no dev global dominates.
      if (REACT_REFRESH_REGISTRY_EDGE_NAMES.has(eName) && edge.toNode.id > 3) {
        byId.set(
          edge.toNode.id,
          `${eName} (React Fast Refresh registry; absent in production builds)`,
        );
        categoryById.set(edge.toNode.id, 'reactFastRefresh');
      }
      // The signature record itself, so entries survive being read out of a
      // WeakMap whose table is not itself dominated by the registry edge.
      if (
        eName === REACT_REFRESH_SIGNATURE_GATE_PROP &&
        node.id > 3 &&
        isReactRefreshSignatureRecord(node)
      ) {
        byId.set(
          node.id,
          'react-refresh signature record ({forceReset, ownKey, fullKey, getCustomHooks}; absent in production builds)',
        );
        categoryById.set(node.id, 'reactFastRefresh');
      }
    }
    if (DEV_NODE_NAME_RE.test(node.name)) {
      byId.set(node.id, node.name);
      categoryById.set(node.id, 'devGlobal');
    }
    if (AX_NODE_NAME_RE.test(node.name)) {
      byId.set(node.id, `${node.name} (a11y/CDP automation cache)`);
      categoryById.set(node.id, 'a11y');
    }
    if (HARNESS_NODE_NAME_RE.test(node.name)) {
      byId.set(node.id, `${node.name} (automation/devtools bridge)`);
      categoryById.set(node.id, 'harness');
    }
  });
  return {byId, categoryById};
}

/**
 * Reachability from GC roots with every dev/automation root treated as a sink
 * (its outgoing edges are not followed). Returns a bitmap indexed by
 * `node.nodeIndex`: 1 = still reachable from a real GC root without passing
 * through a dev root (production-reachable), 0 = reachable ONLY through one or
 * more dev roots (a dev/automation-only artifact).
 *
 * This is stricter and more complete than a dominator walk: when an object is
 * co-retained by SEVERAL different dev roots (e.g. the DevTools console AND the
 * a11y cache both point at the same detached-DOM subtree), no single dev root
 * dominates it, so a dominator walk misses it — but it is still dev-only because
 * every path to it passes through some dev root. This pass catches that case.
 */
export function computeReachableWithoutDevRoots(
  snapshot: IHeapSnapshot,
  devRoots: DevRoots,
): Uint8Array {
  const {byId} = devRoots;
  const reached = new Uint8Array(snapshot.nodes.length);
  const stack: IHeapNode[] = [];
  // Seed from the synthetic GC roots (the "(GC roots)" super-root and its
  // synthetic children such as "(Global handles)"): all real objects are
  // reachable from these. A dev root that is itself synthetic is seeded but not
  // expanded.
  snapshot.nodes.forEach(node => {
    if (node.type !== 'synthetic' && node.id > 3) return;
    if (reached[node.nodeIndex]) return;
    reached[node.nodeIndex] = 1;
    if (!byId.has(node.id)) stack.push(node);
  });
  while (stack.length > 0) {
    const node = stack.pop() as IHeapNode;
    node.forEachReference((edge: IHeapEdge) => {
      const to = edge.toNode;
      if (reached[to.nodeIndex]) return;
      reached[to.nodeIndex] = 1;
      // Mark the dev root reached (it is held by a real global handle) but do
      // NOT follow its edges — anything reachable only through it is dev-only.
      if (!byId.has(to.id)) stack.push(to);
    });
  }
  return reached;
}

export interface DevOnlyTotals {
  nodes: number;
  retained: number;
  byCategory: Map<DevRootCategory, {nodes: number; selfBytes: number}>;
}

const CATEGORY_BIT: Record<DevRootCategory, number> = {
  console: 1,
  a11y: 2,
  devGlobal: 4,
  reactDebugStack: 8,
  reactFastRefresh: 16,
  harness: 32,
};

/**
 * Whole-heap total of everything retained ONLY via dev/automation roots, plus a
 * per-source breakdown.
 *
 * This is deliberately independent of any display threshold. The previous
 * implementation accumulated the total inside the same loop that filtered
 * candidates by `min_retained_size`, so the headline number only counted
 * objects above the cutoff. With the 512 KB default that made a heap holding
 * thousands of small console-retained objects report **0 B dev-only** — read by
 * a caller as "this is production-real". Whole classes of artifact (per-event
 * log strings, one logged object per interaction) are individually tiny and
 * collectively large, which is exactly the case that matters.
 *
 * Attribution is a single BFS over the dev-only subgraph, seeded from each dev
 * root's dev-only successors and OR-ing a category bit as it goes, so a subtree
 * co-retained by several artifact families is counted under each.
 */
export function summarizeDevOnly(
  snapshot: IHeapSnapshot,
  devRoots: DevRoots,
  reached: Uint8Array,
): DevOnlyTotals {
  const {byId, categoryById} = devRoots;
  const mask = new Uint8Array(snapshot.nodes.length);
  const stack: IHeapNode[] = [];
  const devOnlyIds = new NumericSet();
  let nodes = 0;

  // Seed: dev-only successors of each dev root, tagged with that root's family.
  snapshot.nodes.forEach(node => {
    const cat = categoryById.get(node.id);
    if (cat == null || !byId.has(node.id)) return;
    const bit = CATEGORY_BIT[cat];
    node.forEachReference((edge: IHeapEdge) => {
      const to = edge.toNode;
      if (reached[to.nodeIndex]) return; // production-reachable, not an artifact
      if ((mask[to.nodeIndex] & bit) !== 0) return;
      mask[to.nodeIndex] |= bit;
      stack.push(to);
    });
  });

  while (stack.length > 0) {
    const node = stack.pop() as IHeapNode;
    const bits = mask[node.nodeIndex];
    node.forEachReference((edge: IHeapEdge) => {
      const to = edge.toNode;
      if (reached[to.nodeIndex]) return;
      if ((mask[to.nodeIndex] & bits) === bits) return; // nothing new to add
      mask[to.nodeIndex] |= bits;
      stack.push(to);
    });
  }

  const byCategory = new Map<
    DevRootCategory,
    {nodes: number; selfBytes: number}
  >();
  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;
    if (reached[node.nodeIndex]) return;
    nodes++;
    devOnlyIds.add(node.id);
    const bits = mask[node.nodeIndex];
    for (const cat of Object.keys(CATEGORY_BIT) as DevRootCategory[]) {
      if ((bits & CATEGORY_BIT[cat]) === 0) continue;
      const cur = byCategory.get(cat) ?? {nodes: 0, selfBytes: 0};
      cur.nodes++;
      cur.selfBytes += node.self_size;
      byCategory.set(cat, cur);
    }
  });

  // Dominator-deduplicated so nested artifacts are not double-counted.
  const retained =
    nodes === 0
      ? 0
      : utils.aggregateDominatorMetrics(
          devOnlyIds,
          snapshot,
          () => true,
          (node: IHeapNode) => node.retainedSize,
        );

  return {nodes, retained, byCategory};
}

/**
 * Find a dev-root name on the node's shortest retainer path, for the "via"
 * label. Best-effort: the shortest path usually runs through the dominant
 * retainer; falls back to a generic label when it does not.
 */
function findDevRootVia(node: IHeapNode, devRoots: DevRoots): string | null {
  let cur: IHeapNode | null = node;
  const seen = new Set<number>();
  let steps = 0;
  while (cur && cur.hasPathEdge && steps < 1000) {
    const edge: IHeapEdge | null = cur.pathEdge;
    if (!edge) break;
    const from: IHeapNode = edge.fromNode;
    const via = devRoots.byId.get(from.id);
    if (via != null) return via;
    if (seen.has(from.id)) break;
    seen.add(from.id);
    cur = from;
    steps++;
  }
  return null;
}

/**
 * Classify whether a node is retained ONLY via dev/automation roots. Prefer the
 * reachability bitmap from `computeReachableWithoutDevRoots` (rigorous and
 * complete, including multi-dev-root co-retention). Without a bitmap, fall back
 * to a dominator walk: if a dev root *dominates* the node, every path to it
 * passes through that dev object — conservative, catches only single-dev-root
 * retention.
 */
export function classifyDevOnly(
  node: IHeapNode,
  devRoots: DevRoots,
  reached?: Uint8Array,
  maxWalk = 1000,
): {devOnly: boolean; via: string | null} {
  if (devRoots.byId.size === 0) return {devOnly: false, via: null};
  if (reached != null) {
    if (reached[node.nodeIndex]) return {devOnly: false, via: null};
    return {
      devOnly: true,
      via: findDevRootVia(node, devRoots) ?? 'dev/automation roots',
    };
  }
  let cur: IHeapNode | null = node.dominatorNode ?? null;
  let steps = 0;
  while (cur && steps < maxWalk) {
    const via = devRoots.byId.get(cur.id);
    if (via != null) return {devOnly: true, via};
    if (cur.dominatorNode?.id === cur.id) break;
    cur = cur.dominatorNode ?? null;
    steps++;
  }
  return {devOnly: false, via: null};
}

/**
 * The families this tool knows how to look for, and whether any root for each
 * was found. Printed on demand because the failure mode of a hardcoded family
 * list is silence: a family nobody thought of contributes 0 bytes and reads
 * exactly like "there are no artifacts in this snapshot".
 */
function explainCoverage(devRoots: DevRoots): string {
  const seen = new Map<DevRootCategory, number>();
  for (const cat of devRoots.categoryById.values()) {
    seen.set(cat, (seen.get(cat) ?? 0) + 1);
  }
  const families: Array<[DevRootCategory, string, string]> = [
    [
      'devGlobal',
      'Dev/extension globals + dev-tools bridges',
      [...DEV_GLOBAL_EDGE_NAMES].join(', ') +
        `; node names matching ${DEV_BRIDGE_NODE_NAME_RE}`,
    ],
    [
      'reactFastRefresh',
      'React Fast Refresh registries',
      [...REACT_REFRESH_GLOBAL_EDGE_NAMES].join(', '),
    ],
    [
      'a11y',
      'Blink accessibility caches (CDP-inflated)',
      String(AX_NODE_NAME_RE),
    ],
    [
      'console',
      'Inspector console retention',
      `${GLOBAL_HANDLES_NODE_NAME} edges matching ${CONSOLE_HANDLE_EDGE_RE}`,
    ],
    [
      'harness',
      'Automation/test-harness bundle',
      [...HARNESS_EDGE_NAMES].join(', ') + `; ${HARNESS_NODE_NAME_RE}`,
    ],
    [
      'reactDebugStack',
      'React DEV owner stacks',
      [...REACT_DEBUG_STACK_EDGE_NAMES].join(', '),
    ],
  ];
  const rows = families.map(([cat, name, rule]) => [
    name,
    seen.has(cat) ? `${seen.get(cat)} root(s)` : 'none found',
    rule.length > 90 ? rule.slice(0, 87) + '…' : rule,
  ]);
  const extraGlobals = [...extraDevGlobalNames()];
  const extraPattern = process.env.MEMLAB_DEV_ARTIFACT_NODE_PATTERN;
  const lines = [
    '### Families checked',
    '',
    markdownTable(['Family', 'Found here', 'Match rule'], rows),
    '',
    extraGlobals.length > 0 || extraPattern
      ? `Deployment additions in effect: ${extraGlobals.length > 0 ? `globals [${extraGlobals.join(', ')}]` : ''}${extraGlobals.length > 0 && extraPattern ? '; ' : ''}${extraPattern ? `node pattern /${extraPattern}/` : ''}.`
      : '_No deployment additions configured. If a family below reads "none found" but you know the surface has one, teach it: `MEMLAB_DEV_ARTIFACT_GLOBALS=name1,name2` for a window global, `MEMLAB_DEV_ARTIFACT_NODE_PATTERN=regex` for a module/bridge reached through the app\'s own registry._',
    '',
    '_"none found" means no ROOT for that family exists in this capture — it does not mean the family was ruled out for the objects you are looking at._',
  ];
  return lines.join('\n');
}

export function registerDevArtifacts(server: McpServer): void {
  server.tool(
    'memlab_dev_artifacts',
    'Classify large retainers as production-relevant vs. dev/automation-only (browser snapshots). Flags any object retained ONLY through a dev/extension global (__REACT_DEVTOOLS_GLOBAL_HOOK__, __REDUX_DEVTOOLS_EXTENSION__, window.Debug, …), through a Blink accessibility cache (AXObjectCacheImpl/AXNodeObject/AXDirtyObject) inflated by CDP-driven automation building the a11y tree, OR through the attached inspector\'s console — objects passed to console.log / a dev-build devConsole are held by DevTools/CDP via "(Global handles) → … / DevTools console" edges (and can pin a whole detached DOM subtree, e.g. a logged {node} ref), which are GC\'d once DevTools/automation detaches. All three are measurement artifacts that should not be counted as production leaks. Reports total bytes attributable to them so "241 MB leak!" headlines that are really DevTools / a11y-cache / console retention get caught.',
    {
      limit: z
        .number()
        .optional()
        .default(25)
        .describe('Maximum number of objects to classify (default 25).'),
      explain: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'List every artifact family this tool checks and whether roots for it were found in this snapshot (default false). A family that is missing from the built-in set produces a silent zero, which reads as "no artifacts here" — this makes the coverage visible so a miss can be recognised and, if needed, taught with MEMLAB_DEV_ARTIFACT_GLOBALS / MEMLAB_DEV_ARTIFACT_NODE_PATTERN.',
        ),
      min_retained_size: z
        .number()
        .optional()
        .default(524288)
        .describe(
          'Only consider objects retaining at least this (default 512 KB).',
        ),
      only_dev: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Show only the dev-only artifacts (default false: show both, dev-only flagged).',
        ),
      show_roots: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'List every dev/automation root by name instead of summarizing them as counts per family (default false). The full list is unbounded — one root per a11y object and per bridge export — and cost ~1,500 tokens per call on a measured run. Use it only when chasing one specific root.',
        ),
      summary_only: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Headline totals and the per-source breakdown ONLY — no per-object classification table and no below-threshold aggregation (default false). This is the largest single output of any tool here, and after the first call in a session the tables are usually re-read for a number that is already in the headline.',
        ),
    },
    async ({
      limit,
      min_retained_size,
      only_dev,
      show_roots,
      explain,
      summary_only,
    }) => {
      try {
        const snapshot = getSnapshot();
        const meta = getSnapshotMetadata();
        const totalSize = meta?.totalSize ?? 0;
        const devRoots = collectDevRoots(snapshot);

        if (devRoots.byId.size === 0) {
          return toolResult(
            'No dev/extension globals (__REACT_DEVTOOLS_GLOBAL_HOOK__, __REDUX_DEVTOOLS_EXTENSION__, window.Debug, …) or accessibility caches (AXObjectCacheImpl, …) found in this snapshot. ' +
              'Either this is a production/clean capture, or none were installed — large retainers here are NOT dev/automation artifacts.' +
              (explain ? '\n\n' + explainCoverage(devRoots) : ''),
          );
        }

        // One reachability pass (dev roots as sinks) drives every
        // classification below — catches multi-dev-root co-retention that a
        // per-node dominator walk misses.
        const reached = computeReachableWithoutDevRoots(snapshot, devRoots);

        // Collect the largest inspectable objects, then classify each.
        interface Cand {
          node: IHeapNode;
          devOnly: boolean;
          via: string | null;
        }
        const cands: Cand[] = [];
        // Whole-heap total, independent of `min_retained_size` (see
        // summarizeDevOnly): the headline number must never be filtered by the
        // display threshold.
        const totals = summarizeDevOnly(snapshot, devRoots, reached);
        let examined = 0;
        let skippedBySize = 0;
        // Dev-only objects that fall UNDER the display threshold, aggregated by
        // class. The headline total already counts them, but the table did not
        // show them at any size, so the common shape of an automation artifact —
        // thousands of ~10 KB console-retained records, none individually near
        // the 512 KB default — was invisible: a reader saw "N MB is dev-only",
        // scanned an empty-looking table, and concluded there was nothing to
        // discount. Grouping restores them without lowering the threshold.
        const belowByClass = new Map<string, {count: number; bytes: number}>();
        let belowDevOnlyCount = 0;
        let belowDevOnlyBytes = 0;
        snapshot.nodes.forEach(node => {
          if (node.id <= 3) return;
          if (
            node.type !== 'object' &&
            node.type !== 'closure' &&
            node.type !== 'array'
          )
            return;
          examined++;
          if (node.retainedSize < min_retained_size) {
            skippedBySize++;
            // Test reachability directly rather than via classifyDevOnly: the
            // latter also resolves the "via" label by walking retainers, which
            // is far too expensive to pay per node on the below-threshold tail.
            if (reached[node.nodeIndex] === 0) {
              belowDevOnlyCount++;
              // SELF size, not retained: retained sizes overlap wherever these
              // objects nest, so summing them across a class reports more than
              // exists. Self size is additive, and matches the units the
              // "By source" breakdown above already uses.
              belowDevOnlyBytes += node.self_size;
              const key =
                node.name.length > 0
                  ? truncateNodeName(node.name, node.type, node.self_size, 40)
                  : `(unnamed ${node.type})`;
              const e = belowByClass.get(key);
              if (e) {
                e.count++;
                e.bytes += node.self_size;
              } else {
                belowByClass.set(key, {count: 1, bytes: node.self_size});
              }
            }
            return;
          }
          const {devOnly, via} = classifyDevOnly(node, devRoots, reached);
          if (only_dev && !devOnly) return;
          // keep top-N by retained size
          const size = node.retainedSize;
          let i = 0;
          for (; i < cands.length; i++) {
            if (size > cands[i].node.retainedSize) break;
          }
          cands.splice(i, 0, {node, devOnly, via});
          if (cands.length > limit) cands.length = limit;
        });

        const breakdown = [...totals.byCategory.entries()]
          .sort((a, b) => b[1].selfBytes - a[1].selfBytes)
          .map(
            ([cat, v]) =>
              `${CATEGORY_LABEL[cat]} ${formatBytes(v.selfBytes)} self across ${formatNumber(v.nodes)} objects`,
          );

        const lines: string[] = [
          '## Dev-only artifact classification',
          '',
          `Dev/automation roots present: ${summarizeDevRoots(devRoots, show_roots)}`,
          `Total retained held ONLY via dev/automation artifacts: **${formatBytes(totals.retained)}** across **${formatNumber(totals.nodes)} objects**` +
            (totalSize > 0
              ? ` (${Math.min(100, (totals.retained / totalSize) * 100).toFixed(1)}% of heap — exclude from production leak totals)`
              : ''),
        ];
        if (breakdown.length > 0) {
          lines.push(`By source: ${breakdown.join(' · ')}`);
        }
        lines.push(
          '_This total covers the whole heap and is NOT limited by `min_retained_size` — high-count/low-size artifacts (per-event log strings, one logged object per interaction) are included._',
          '',
          "> ⚠️ **This is not the whole artifact bill.** This tool measures RETENTION-BY-A-DEV-ROOT (dev/extension globals, the inspector console, a11y caches, Fast Refresh, the automation bridge). It does NOT count **V8 JIT warmup** — `system/Code`, `InstructionStream`, `BytecodeArray`, `ProtectedFixedArray` — which is a separate and often larger bucket, and which grows simply because a hunt exercises new code paths. On one measured round this tool reported 4.8 MB / 1.5% dev-only while JIT warmup accounted for +5.7 MB of that round's 10.8 MB of growth. For the growth-side view of both, run `memlab_explain_delta` with `include_artifacts: true` against the baseline rung.",
          '',
        );

        if (summary_only) {
          // Say what was withheld and how to get it. A tool that quietly prints
          // less reads as a tool that found less.
          lines.push(
            `_summary_only: the ${formatNumber(cands.length)}-row classification table` +
              (belowDevOnlyCount > 0
                ? ` and the below-threshold aggregation (${formatNumber(belowDevOnlyCount)} objects)`
                : '') +
              ' are withheld. Re-run with `summary_only: false` for them._',
          );
          if (explain) {
            lines.push('', explainCoverage(devRoots));
          }
          return toolResult(lines.join('\n'));
        }

        if (cands.length > 0) {
          const headers = ['ID', 'Name', 'Type', 'Retained', 'Classification'];
          const rightCols = new Set([3]);
          const rows = cands.map(c => [
            `@${c.node.id}`,
            truncateNodeName(c.node.name, c.node.type, c.node.self_size, 40),
            c.node.type,
            formatBytes(c.node.retainedSize),
            c.devOnly ? `dev-only (via ${c.via})` : 'production',
          ]);
          lines.push(markdownTable(headers, rows, rightCols));
        } else {
          lines.push('No objects matched the size threshold.');
        }
        lines.push(
          '',
          describeSkipped(
            examined,
            skippedBySize,
            `min_retained_size (${formatBytes(min_retained_size)})`,
          ),
        );

        // Below-threshold dev-only artifacts, grouped so a large aggregate made
        // of small objects is visible in the table rather than only in the
        // headline total.
        if (belowDevOnlyCount > 0) {
          const top = [...belowByClass.entries()]
            .sort((a, b) => b[1].bytes - a[1].bytes)
            .slice(0, 8);
          lines.push(
            '',
            `### Below \`min_retained_size\` — dev-only, aggregated by class`,
            '',
            `**${formatNumber(belowDevOnlyCount)} dev-only object(s) totalling ${formatBytes(belowDevOnlyBytes)} of self size** are individually under the ${formatBytes(min_retained_size)} threshold, so none appears above. This is the usual shape of an automation artifact: many small records, no single large one.`,
            '',
            markdownTable(
              ['Class', 'Count', 'Self (sum)'],
              top.map(([name, v]) => [
                name,
                formatNumber(v.count),
                formatBytes(v.bytes),
              ]),
              new Set([1, 2]),
            ),
          );
          if (belowByClass.size > top.length) {
            lines.push(
              '',
              `_… +${formatNumber(belowByClass.size - top.length)} more class(es). Lower \`min_retained_size\` to list individual objects._`,
            );
          }
        }
        lines.push(
          '',
          '_"dev-only" = the object\'s dominator chain passes through a dev/extension global, a Blink a11y cache, or an inspector "DevTools console" global handle, so every retainer path goes through it. Dev-global-retained objects would be GC\'d in production; a11y-cache and DevTools-console retention are automation/inspector-inflated (the a11y tree is materialized by CDP; console-logged objects are held by the attached inspector) and not present in a normal user session with DevTools closed. Either way, discount from production leak totals. Verify with `memlab_retainer_trace`._',
        );
        if (explain) {
          lines.push('', explainCoverage(devRoots));
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
