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
import {z} from 'zod';
import {getSnapshot, getSnapshotMetadata} from '../heap-state.js';
import {
  formatBytes,
  markdownTable,
  truncateNodeName,
  errorResult,
  toolResult,
} from '../utils.js';

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

const DEV_NODE_NAME_RE = /__REACT_DEVTOOLS|DEVTOOLS_GLOBAL_HOOK|ReactDevTools/;

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

export interface DevRoots {
  // dev-root node id -> the global name it is installed under
  byId: Map<number, string>;
}

/**
 * Find the dev/extension "root" objects: the targets of dev-global edges on
 * the Window/global object, plus any node whose own name marks it as a
 * devtools hook.
 */
export function collectDevRoots(snapshot: IHeapSnapshot): DevRoots {
  const byId = new Map<number, string>();
  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;
    const isGlobal =
      node.name.startsWith('Window ') ||
      node.name === 'global' ||
      node.name === 'globalThis';
    if (isGlobal) {
      for (const edge of node.references) {
        const eName = String(edge.name_or_index);
        if (DEV_GLOBAL_EDGE_NAMES.has(eName) && edge.toNode.id > 3) {
          byId.set(edge.toNode.id, eName);
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
        }
      }
    }
    if (DEV_NODE_NAME_RE.test(node.name)) {
      byId.set(node.id, node.name);
    }
    if (AX_NODE_NAME_RE.test(node.name)) {
      byId.set(node.id, `${node.name} (a11y/CDP automation cache)`);
    }
  });
  return {byId};
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
    },
    async ({limit, min_retained_size, only_dev}) => {
      try {
        const snapshot = getSnapshot();
        const meta = getSnapshotMetadata();
        const totalSize = meta?.totalSize ?? 0;
        const devRoots = collectDevRoots(snapshot);

        if (devRoots.byId.size === 0) {
          return toolResult(
            'No dev/extension globals (__REACT_DEVTOOLS_GLOBAL_HOOK__, __REDUX_DEVTOOLS_EXTENSION__, window.Debug, …) or accessibility caches (AXObjectCacheImpl, …) found in this snapshot. ' +
              'Either this is a production/clean capture, or none were installed — large retainers here are NOT dev/automation artifacts.',
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
        let devOnlyBytes = 0;
        snapshot.nodes.forEach(node => {
          if (node.id <= 3) return;
          if (node.retainedSize < min_retained_size) return;
          if (
            node.type !== 'object' &&
            node.type !== 'closure' &&
            node.type !== 'array'
          )
            return;
          const {devOnly, via} = classifyDevOnly(node, devRoots, reached);
          if (devOnly) devOnlyBytes += node.retainedSize;
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

        const lines: string[] = [
          '## Dev-only artifact classification',
          '',
          `Dev/automation roots present: ${[...new Set(devRoots.byId.values())].join(', ')}`,
          `Total retained held ONLY via dev/automation artifacts: **${formatBytes(devOnlyBytes)}**` +
            (totalSize > 0
              ? ` (${Math.min(100, (devOnlyBytes / totalSize) * 100).toFixed(1)}% of heap — exclude from production leak totals)`
              : ''),
          '',
        ];

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
          '_"dev-only" = the object\'s dominator chain passes through a dev/extension global, a Blink a11y cache, or an inspector "DevTools console" global handle, so every retainer path goes through it. Dev-global-retained objects would be GC\'d in production; a11y-cache and DevTools-console retention are automation/inspector-inflated (the a11y tree is materialized by CDP; console-logged objects are held by the attached inspector) and not present in a normal user session with DevTools closed. Either way, discount from production leak totals. Verify with `memlab_retainer_trace`._',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
