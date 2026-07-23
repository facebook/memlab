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
import {z} from 'zod';
import {getSnapshot, getSnapshotEnv} from '../heap-state.js';
import type {IHeapNode, IHeapEdge} from '@memlab/core';
import {
  queryNodes,
  formatQueryNodesResult,
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';
import type {OutputMode} from '../utils.js';
import {collectDevRoots, classifyDevOnly} from './dev-artifacts.js';

function isDetachedDOMNode(node: IHeapNode): boolean {
  if (node.id <= 3) return false;
  if (node.is_detached) return true;
  return node.name.startsWith('Detached ');
}

// A detached node is only an actual leak if it is still reachable from a GC
// root — i.e. it has a shortest-path retainer edge. Detached nodes with NO
// retainer path found are typically GC-eligible (about to be collected) or
// retained only through weak references, and should not be counted toward a
// leak total. This distinguishes the "which half is real" problem where a
// snapshot's detached-node list mixes genuinely-pinned nodes with transient
// ones. `hasPathEdge` is the same reachability signal used to walk retainers.
function isPinned(node: IHeapNode): boolean {
  return Boolean(node.hasPathEdge);
}

interface ReachabilitySplit {
  pinnedCount: number;
  pinnedRetained: number;
  noPathCount: number;
  noPathRetained: number;
}

function formatReachabilitySplit(split: ReachabilitySplit): string[] {
  return [
    `- Pinned (retainer path to a GC root — actionable leak): ${formatNumber(split.pinnedCount)} nodes, ${formatBytes(split.pinnedRetained)}`,
    `- No retainer path found (likely GC-eligible / weak-only — exclude from leak totals): ${formatNumber(split.noPathCount)} nodes, ${formatBytes(split.noPathRetained)}`,
  ];
}

function extractElementTag(name: string): string {
  // V8 names detached DOM as "Detached <div>" or "Detached <div class="...">"
  const match = name.match(/^(?:Detached\s+)?<(\w+)/);
  return match ? match[1] : name;
}

function extractTestId(node: IHeapNode): string {
  // Look for data-testid in the node name (V8 includes attributes)
  const testIdMatch = node.name.match(/data-testid="([^"]+)"/);
  if (testIdMatch) return testIdMatch[1];
  return '(no testid)';
}

function getFirstNonFrameworkRetainer(node: IHeapNode): string {
  const frameworkNames = new Set([
    'system / Context',
    '(GC roots)',
    '(Strong roots)',
    '(Builtins)',
    '(Startup object cache)',
  ]);
  let cur: IHeapNode | null = node;
  const visited = new Set<number>([node.id]);

  while (cur && cur.hasPathEdge) {
    const edge: IHeapEdge | null = cur.pathEdge;
    if (!edge) break;
    const from: IHeapNode = edge.fromNode;
    if (visited.has(from.id)) break;
    visited.add(from.id);

    if (
      !frameworkNames.has(from.name) &&
      !from.name.startsWith('system / ') &&
      from.type !== 'hidden' &&
      from.type !== 'array' &&
      from.type !== 'synthetic' &&
      from.type !== 'native'
    ) {
      const edgeName = String(edge.name_or_index);
      return `${from.name} (${from.type}) .${edgeName}`;
    }
    cur = from;
  }
  return '(unknown)';
}

interface GroupStats {
  count: number;
  totalRetained: number;
  exampleId: number;
  maxRetainedSize: number;
}

export function registerDetachedDom(server: McpServer): void {
  server.tool(
    'memlab_detached_dom',
    'Find detached DOM elements still retained in memory. These are common sources of memory leaks — DOM nodes removed from the document but kept alive by JavaScript references. Supports count-only and ids-only modes for large result sets. Use group_by to aggregate by element tag, retainer pattern, or data-testid. ' +
      'Reports a pinned-vs-GC-eligible split: detached nodes with a retainer path to a GC root are actual leaks, while nodes with no retainer path found are typically GC-eligible (transient / weak-only) and should be excluded from leak totals — set only_with_retainer_path to list/aggregate just the pinned ones. ' +
      '⚠ Full-heap scan — slow on very large heaps (millions of nodes); use count-only / ids-only modes and group_by to bound output.',
    {
      output_mode: z
        .enum(['full', 'count', 'ids'])
        .optional()
        .default('full')
        .describe(
          'Output verbosity: "full" returns node summaries (default), "count" returns only the total count, "ids" returns only node IDs',
        ),
      group_by: z
        .enum(['element', 'retainer', 'testid'])
        .optional()
        .describe(
          'Group detached DOM nodes instead of listing individually. "element" groups by HTML tag (div, span, button), "retainer" groups by first non-framework retainer (the component/module holding them), "testid" groups by data-testid attribute.',
        ),
      offset: z
        .number()
        .optional()
        .default(0)
        .describe('Skip the first N results (for pagination)'),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe(
          'Maximum number of results (default 20, up to 10000 for ids mode)',
        ),
      classify_dev_only: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Report how much detached DOM is retained ONLY via dev/automation artifacts — dev/extension globals (__REACT_DEVTOOLS_GLOBAL_HOOK__, window.Debug, …) or the Blink a11y/CDP cache (AXObjectCacheImpl, which co-retains detached DOM under automation) — and so should be excluded from production leak totals (default true). Use memlab_dev_artifacts for the full breakdown.',
        ),
      only_with_retainer_path: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Only include detached nodes that have a retainer path to a GC root (i.e. actually pinned / leaked). When false (default) all detached nodes are included, but the summary always reports the pinned-vs-GC-eligible split so transient / weak-only detached DOM is not mistaken for a leak.',
        ),
    },
    async ({
      output_mode,
      group_by,
      offset,
      limit,
      classify_dev_only,
      only_with_retainer_path,
    }) => {
      try {
        const env = getSnapshotEnv();
        if (env === 'node') {
          return toolResult(
            'This is a Node.js snapshot — DOM nodes do not exist in this environment.\n\n' +
              'For Node.js memory investigation, try instead:\n' +
              '- `memlab_duplicated_strings` — find duplicated string instances\n' +
              '- `memlab_closure_inspection` — inspect closure captured variables\n' +
              '- `memlab_largest_objects` — find objects consuming the most memory\n' +
              '- `memlab_class_histogram` — per-class instance counts and sizes',
          );
        }
        const snapshot = getSnapshot();
        const devRoots = classify_dev_only ? collectDevRoots(snapshot) : null;

        if (group_by) {
          const groups = new Map<string, GroupStats>();
          let totalDetached = 0;
          let totalRetainedAll = 0;
          let devOnlyRetained = 0;
          const split: ReachabilitySplit = {
            pinnedCount: 0,
            pinnedRetained: 0,
            noPathCount: 0,
            noPathRetained: 0,
          };

          snapshot.nodes.forEach(node => {
            if (!isDetachedDOMNode(node)) return;
            totalDetached++;
            totalRetainedAll += node.retainedSize;
            const pinned = isPinned(node);
            if (pinned) {
              split.pinnedCount++;
              split.pinnedRetained += node.retainedSize;
            } else {
              split.noPathCount++;
              split.noPathRetained += node.retainedSize;
            }
            if (devRoots && classifyDevOnly(node, devRoots).devOnly) {
              devOnlyRetained += node.retainedSize;
            }

            // With only_with_retainer_path, exclude GC-eligible (no-path) nodes
            // from the group aggregation — they are still counted in the split.
            if (only_with_retainer_path && !pinned) return;

            let key: string;
            switch (group_by) {
              case 'element':
                key = extractElementTag(node.name);
                break;
              case 'retainer':
                key = getFirstNonFrameworkRetainer(node);
                break;
              case 'testid':
                key = extractTestId(node);
                break;
            }

            const existing = groups.get(key);
            if (existing) {
              existing.count++;
              existing.totalRetained += node.retainedSize;
              if (node.retainedSize > existing.maxRetainedSize) {
                existing.exampleId = node.id;
                existing.maxRetainedSize = node.retainedSize;
              }
            } else {
              groups.set(key, {
                count: 1,
                totalRetained: node.retainedSize,
                exampleId: node.id,
                maxRetainedSize: node.retainedSize,
              });
            }
          });

          if (groups.size === 0) {
            if (totalDetached > 0) {
              return toolResult(
                [
                  `Detached DOM grouped by ${group_by}: ${formatNumber(totalDetached)} total nodes, ${formatBytes(totalRetainedAll)} total retained`,
                  ...formatReachabilitySplit(split),
                  only_with_retainer_path
                    ? '_No pinned (retainer-path) detached nodes — all detached DOM is GC-eligible / weak-only, not a leak._'
                    : '',
                ].join('\n'),
              );
            }
            return toolResult('No detached DOM nodes found.');
          }

          const sorted = [...groups.entries()]
            .sort((a, b) => b[1].totalRetained - a[1].totalRetained)
            .slice(0, limit);

          const groupLabel =
            group_by === 'element'
              ? 'Element'
              : group_by === 'retainer'
                ? 'Retainer'
                : 'data-testid';

          const headers = [
            groupLabel,
            'Count',
            'Total Retained',
            '% of Detached',
            'Example ID',
          ];
          const rightCols = new Set([1, 2, 3]);
          const rows = sorted.map(([key, stats]) => {
            const pct =
              totalRetainedAll > 0
                ? ((stats.totalRetained / totalRetainedAll) * 100).toFixed(1) +
                  '%'
                : '-';
            return [
              key.length > 60 ? key.slice(0, 57) + '...' : key,
              formatNumber(stats.count),
              formatBytes(stats.totalRetained),
              pct,
              `@${stats.exampleId}`,
            ];
          });

          const lines = [
            `Detached DOM grouped by ${group_by}: ${formatNumber(totalDetached)} total nodes, ${formatBytes(totalRetainedAll)} total retained`,
            ...formatReachabilitySplit(split),
          ];
          if (only_with_retainer_path) {
            lines.push('_(groups below show pinned nodes only)_');
          }
          lines.push('', markdownTable(headers, rows, rightCols));

          if (devRoots && devRoots.byId.size > 0 && devOnlyRetained > 0) {
            const pct =
              totalRetainedAll > 0
                ? ((devOnlyRetained / totalRetainedAll) * 100).toFixed(0)
                : '0';
            lines.push(
              '',
              `⚠ **${formatBytes(devOnlyRetained)} (${pct}%) of this detached DOM is retained ONLY via dev/automation artifacts** (${[...new Set(devRoots.byId.values())].join(', ')}) — dev-global retention would be GC'd in production, and a11y/CDP-cache retention is automation-inflated (not present at that scale in a normal session). Exclude it from leak totals; run \`memlab_dev_artifacts\` for the breakdown.`,
            );
          }

          if (sorted.length > 0) {
            lines.push(
              '',
              `**Suggested action:** Use \`memlab_retainer_summary\` with node_ids from the top group's example to trace the common retention pattern.`,
            );
          }

          return toolResult(lines.join('\n'));
        }

        const split: ReachabilitySplit = {
          pinnedCount: 0,
          pinnedRetained: 0,
          noPathCount: 0,
          noPathRetained: 0,
        };
        snapshot.nodes.forEach(node => {
          if (!isDetachedDOMNode(node)) return;
          if (isPinned(node)) {
            split.pinnedCount++;
            split.pinnedRetained += node.retainedSize;
          } else {
            split.noPathCount++;
            split.noPathRetained += node.retainedSize;
          }
        });

        const predicate = only_with_retainer_path
          ? (n: IHeapNode): boolean => isDetachedDOMNode(n) && isPinned(n)
          : isDetachedDOMNode;

        const effectiveLimit =
          output_mode === 'ids' ? Math.min(limit, 10000) : Math.min(limit, 500);

        const result = queryNodes(snapshot, predicate, {
          limit: effectiveLimit,
          offset,
          outputMode: output_mode as OutputMode,
        });

        const splitBlock =
          output_mode === 'ids'
            ? ''
            : formatReachabilitySplit(split).join('\n') + '\n\n';
        const output = splitBlock + formatQueryNodesResult(result, offset);
        if (result.total_count > 0 && output_mode === 'full') {
          const devNote =
            devRoots && devRoots.byId.size > 0
              ? ` Dev/extension globals (${[...new Set(devRoots.byId.values())].join(', ')}) are present — run \`memlab_dev_artifacts\` to exclude DevTools-only retention from leak totals.`
              : '';
          const pinnedNote =
            split.noPathCount > 0
              ? ` ${formatNumber(split.noPathCount)} detached node(s) have no retainer path (likely GC-eligible / weak-only) — pass only_with_retainer_path to focus on the ${formatNumber(split.pinnedCount)} pinned one(s).`
              : '';
          return toolResult(
            output +
              '\n\n---\n\n' +
              '**Suggested action:** Check for missing `removeEventListener` calls, ' +
              'React component cleanup in `useEffect` return, or refs not cleared on unmount. ' +
              'Use `memlab_retainer_trace` on top entries to find the retention path. ' +
              'Use `group_by: "retainer"` to see which components are retaining the most detached DOM.' +
              pinnedNote +
              devNote,
          );
        }
        return toolResult(output);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
