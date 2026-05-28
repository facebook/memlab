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
import type {IHeapNode, IHeapEdge} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot, getSnapshotEnv} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';

const COLLECTION_NAMES = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Array']);

function isCollectionNode(node: IHeapNode): boolean {
  return node.type === 'object' && COLLECTION_NAMES.has(node.name);
}

function isStaleNode(node: IHeapNode): boolean {
  // Detached DOM nodes
  if (node.is_detached || node.name.startsWith('Detached ')) return true;
  // Detached React Fiber nodes
  if (node.name === 'FiberNode' && node.is_detached) return true;
  return false;
}

function getCollectionChildren(node: IHeapNode): IHeapEdge[] {
  // For Map/Set, follow the 'table' edge to get internal hash table children
  if (node.name === 'Map' || node.name === 'Set') {
    const tableEdge = node.references.find(e => e.name_or_index === 'table');
    if (tableEdge) {
      return tableEdge.toNode.references;
    }
  }
  // For Array and others, use direct references
  return node.references;
}

function isOrphanedEntry(node: IHeapNode): boolean {
  if (node.id <= 3) return false;
  if (node.type !== 'object') return false;
  return node.numOfReferrers <= 1;
}

function hasTerminalStatus(node: IHeapNode): boolean {
  if (node.id <= 3) return false;
  if (node.type !== 'object') return false;

  const TERMINAL_VALUES = new Set([
    'PENDING',
    'UPLOAD_PENDING',
    'UPLOADING',
    'FAILED',
    'ERROR',
    'TIMED_OUT',
    'CANCELLED',
    'EXPIRED',
    'ABORTED',
  ]);

  for (const edge of node.references) {
    const eName = String(edge.name_or_index);
    if (
      eName === 'status' ||
      eName === 'state' ||
      eName === '_status' ||
      eName === '_state'
    ) {
      const target = edge.toNode;
      if (target.isString) {
        const strNode = target.toStringNode();
        if (strNode && TERMINAL_VALUES.has(strNode.stringValue)) {
          return true;
        }
      }
    }
  }
  return false;
}

interface CollectionStat {
  collection: IHeapNode;
  stale_item_count: number;
  stale_retained_size: number;
  total_children: number;
  stale_reason: string;
}

export function registerStaleCollections(server: McpServer): void {
  server.tool(
    'memlab_stale_collections',
    'Find Map, Set, and Array collections holding stale references. Detects: (1) detached DOM / ' +
      'unmounted Fiber nodes, (2) entries with a status/state property stuck at terminal values ' +
      '(PENDING, FAILED, TIMED_OUT, etc.), and (3) orphaned entries with no referrers outside ' +
      'the collection. Use detect_modes to control which heuristics are applied.',
    {
      limit: z
        .number()
        .optional()
        .default(15)
        .describe('Maximum number of results (default 15)'),
      min_stale_count: z
        .number()
        .optional()
        .default(1)
        .describe(
          'Minimum number of stale entries to include a collection (default 1). Increase to filter out trivially small stale collections.',
        ),
      min_stale_retained_size: z
        .number()
        .optional()
        .default(0)
        .describe(
          'Minimum total stale retained size in bytes to include (default 0). Use e.g., 10240 for 10 KB to filter noise.',
        ),
      detect_modes: z
        .array(z.enum(['detached', 'terminal_status', 'orphaned']))
        .optional()
        .default(['detached', 'terminal_status'])
        .describe(
          'Which stale detection heuristics to apply. "detached" = detached DOM / unmounted Fiber, ' +
            '"terminal_status" = entries with status stuck at terminal values, ' +
            '"orphaned" = entries with no referrers outside the collection (can be slow). Default: detached + terminal_status.',
        ),
    },
    async ({limit, min_stale_count, min_stale_retained_size, detect_modes}) => {
      try {
        const snapshot = getSnapshot();
        const results: CollectionStat[] = [];

        const detectDetached = detect_modes.includes('detached');
        const detectTerminal = detect_modes.includes('terminal_status');
        const detectOrphaned = detect_modes.includes('orphaned');

        snapshot.nodes.forEach(node => {
          if (!isCollectionNode(node)) return;

          const children = getCollectionChildren(node);
          let staleCount = 0;
          let staleRetainedSize = 0;
          let totalChildren = 0;
          let reason = '';

          for (const edge of children) {
            totalChildren++;
            const child = edge.toNode;
            if (child.id <= 3) continue;

            let isStale = false;
            if (detectDetached && isStaleNode(child)) {
              isStale = true;
              if (!reason) reason = 'detached DOM/Fiber';
            }
            if (!isStale && detectTerminal && hasTerminalStatus(child)) {
              isStale = true;
              if (!reason) reason = 'terminal status';
            }
            if (!isStale && detectOrphaned && isOrphanedEntry(child)) {
              isStale = true;
              if (!reason) reason = 'orphaned entries';
            }
            if (isStale) {
              staleCount++;
              staleRetainedSize += child.retainedSize;
            }
          }

          if (
            staleCount >= min_stale_count &&
            staleRetainedSize >= min_stale_retained_size
          ) {
            results.push({
              collection: node,
              stale_item_count: staleCount,
              stale_retained_size: staleRetainedSize,
              total_children: totalChildren,
              stale_reason: reason,
            });
          }
        });

        // Sort by stale retained size descending
        results.sort((a, b) => b.stale_retained_size - a.stale_retained_size);
        const topResults = results.slice(0, limit);

        if (topResults.length === 0) {
          const env = getSnapshotEnv();
          if (env === 'node') {
            return toolResult(
              'No stale collections found. This is a Node.js snapshot — detached DOM detection is not applicable.\n\n' +
                'For Node.js memory investigation, try:\n' +
                '- `memlab_largest_objects` — find objects consuming the most memory\n' +
                '- `memlab_class_histogram` — per-class instance counts and sizes\n' +
                '- `memlab_sliced_strings` — find sliced strings keeping large parents alive',
            );
          }
          return toolResult('No stale collections found.');
        }
        const hasMultipleReasons =
          new Set(topResults.map(r => r.stale_reason)).size > 1;
        const headers = [
          'Collection ID',
          'Name',
          'Stale / Total',
          'Stale Retained',
          ...(hasMultipleReasons ? ['Reason'] : []),
        ];
        const rightCols = new Set([2, 3]);
        const rows = topResults.map(r => [
          `@${r.collection.id}`,
          r.collection.name,
          `${formatNumber(r.stale_item_count)} / ${formatNumber(r.total_children)}`,
          formatBytes(r.stale_retained_size),
          ...(hasMultipleReasons ? [r.stale_reason] : []),
        ]);
        const output = `Stale collections (${topResults.length} found)\n\n${markdownTable(headers, rows, rightCols)}`;
        return toolResult(
          output +
            '\n\n---\n\n' +
            '**Suggested action:** Collections holding detached/stale references prevent garbage collection. ' +
            'Consider using `WeakRef` or `WeakMap`/`WeakSet`, clearing entries on component unmount, ' +
            'or adding bounds to collection size.',
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
