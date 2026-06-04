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
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
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
    if (DEV_NODE_NAME_RE.test(node.name)) {
      byId.set(node.id, node.name);
    }
  });
  return {byId};
}

/**
 * Classify whether a node is retained ONLY via a dev/extension global. We walk
 * the dominator chain upward: if a dev root *dominates* the node, then every
 * path from a GC root to the node passes through that dev object, so it would
 * be collected in production. Using the dominator (not the shortest retainer)
 * makes the "only via" claim rigorous.
 */
export function classifyDevOnly(
  node: IHeapNode,
  devRoots: DevRoots,
  maxWalk = 1000,
): {devOnly: boolean; via: string | null} {
  if (devRoots.byId.size === 0) return {devOnly: false, via: null};
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
    'Classify large retainers as production-relevant vs. dev-only (browser snapshots). Flags any object retained ONLY through a dev/extension global (__REACT_DEVTOOLS_GLOBAL_HOOK__, __REDUX_DEVTOOLS_EXTENSION__, window.Debug, …) — these are profiling artifacts that would be garbage-collected in production and should not be counted as leaks. Reports total bytes attributable to dev artifacts so "241 MB leak!" headlines that are really DevTools retention get caught.',
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
            'No dev/extension globals (__REACT_DEVTOOLS_GLOBAL_HOOK__, __REDUX_DEVTOOLS_EXTENSION__, window.Debug, …) found in this snapshot. ' +
              'Either this is a production/clean capture, or none were installed — large retainers here are NOT dev artifacts.',
          );
        }

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
          const {devOnly, via} = classifyDevOnly(node, devRoots);
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
          `Dev/extension globals present: ${[...new Set(devRoots.byId.values())].join(', ')}`,
          `Total retained held ONLY via dev artifacts: **${formatBytes(devOnlyBytes)}**` +
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
          '_"dev-only" = the object\'s dominator chain passes through a dev/extension global, so every retainer path goes through it and it would be GC\'d in production. Verify with `memlab_retainer_trace`._',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
