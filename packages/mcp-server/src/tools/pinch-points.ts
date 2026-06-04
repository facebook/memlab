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
import {getSnapshot, getSnapshotMetadata} from '../heap-state.js';
import {
  isNodeWorthInspecting,
  formatBytes,
  formatNumber,
  markdownTable,
  truncateNodeName,
  errorResult,
  toolResult,
  suggestionsSuppressed,
} from '../utils.js';

interface PinchPointEntry {
  nodeId: number;
  name: string;
  type: string;
  selfSize: number;
  retainedSize: number;
  ratio: number;
  dominatedCount: number;
}

export function registerPinchPoints(server: McpServer): void {
  server.tool(
    'memlab_pinch_points',
    'Find "pinch points" — small objects that retain disproportionately large subtrees in the dominator tree. These are the most impactful objects to free: a single cache, map, or closure whose removal would reclaim the most memory. Returns objects ranked by retained_size/self_size ratio, filtered to actionable user-code objects (excludes V8 internals).',
    {
      limit: z
        .number()
        .optional()
        .default(15)
        .describe('Maximum number of pinch points to return (default 15)'),
      min_retained_size: z
        .number()
        .optional()
        .default(524288)
        .describe(
          'Minimum retained size in bytes to consider (default 512 KB). Increase for large snapshots.',
        ),
      min_ratio: z
        .number()
        .optional()
        .default(50)
        .describe(
          'Minimum retained_size/self_size ratio (default 50). Higher values find more extreme pinch points.',
        ),
    },
    async ({limit, min_retained_size, min_ratio}) => {
      try {
        const snapshot = getSnapshot();
        const meta = getSnapshotMetadata();
        const totalSize = meta?.totalSize ?? 0;

        const candidates: PinchPointEntry[] = [];

        snapshot.nodes.forEach(node => {
          if (!isNodeWorthInspecting(node)) return;
          if (node.self_size === 0) return;
          if (node.retainedSize < min_retained_size) return;

          const ratio = node.retainedSize / node.self_size;
          if (ratio < min_ratio) return;

          const entry: PinchPointEntry = {
            nodeId: node.id,
            name: node.name,
            type: node.type,
            selfSize: node.self_size,
            retainedSize: node.retainedSize,
            ratio,
            dominatedCount: 0,
          };

          let inserted = false;
          for (let i = 0; i < candidates.length; i++) {
            if (entry.retainedSize > candidates[i].retainedSize) {
              candidates.splice(i, 0, entry);
              inserted = true;
              break;
            }
          }
          if (!inserted) candidates.push(entry);
          if (candidates.length > limit) candidates.length = limit;
        });

        const candidateIds = new Set(candidates.map(c => c.nodeId));
        snapshot.nodes.forEach(node => {
          const domId = node.dominatorNode?.id;
          if (domId != null && candidateIds.has(domId)) {
            const entry = candidates.find(c => c.nodeId === domId);
            if (entry) entry.dominatedCount++;
          }
        });

        if (candidates.length === 0) {
          return toolResult(
            `No pinch points found with retained_size >= ${formatBytes(min_retained_size)} and ratio >= ${min_ratio}:1. Try lowering the thresholds.`,
          );
        }

        const headers = [
          'ID',
          'Name',
          'Type',
          'Self Size',
          'Retained Size',
          'Ratio',
          '% Heap',
          'Dominated',
        ];
        const rightCols = new Set([3, 4, 5, 6, 7]);
        const rows = candidates.map(c => {
          const pct =
            totalSize > 0
              ? ((c.retainedSize / totalSize) * 100).toFixed(1) + '%'
              : '-';
          return [
            `@${c.nodeId}`,
            truncateNodeName(c.name, c.type, c.selfSize, 50),
            c.type,
            formatBytes(c.selfSize),
            formatBytes(c.retainedSize),
            `${formatNumber(Math.round(c.ratio))}:1`,
            pct,
            formatNumber(c.dominatedCount),
          ];
        });

        const lines = [
          `Pinch points: ${candidates.length} objects with high retained/self ratio`,
          '',
          markdownTable(headers, rows, rightCols),
          '',
          '**Interpretation:** Each row is a small object retaining a large subtree. Freeing it (e.g., clearing a cache, removing an event listener) would reclaim the retained size.',
        ];

        if (!suggestionsSuppressed()) {
          const top = candidates[0];
          lines.push(
            '',
            '**Suggested next steps:**',
            `- Inspect top pinch point: \`memlab_get_node(${top.nodeId})\` → \`memlab_object_shape(${top.nodeId})\``,
            `- See what it retains: \`memlab_dominator_subtree(${top.nodeId})\``,
            `- Trace how it's kept alive: \`memlab_retainer_trace(${top.nodeId})\``,
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
