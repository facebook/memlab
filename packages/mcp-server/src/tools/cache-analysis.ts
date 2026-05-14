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
import {getSnapshot, getSnapshotMetadata} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  truncateNodeName,
  errorResult,
  toolResult,
} from '../utils.js';

interface CacheEntry {
  nodeId: number;
  collectionType: string;
  entryCount: number;
  retainedSize: number;
  selfSize: number;
  ownerName: string;
  ownerEdge: string;
  hasWeakRefs: boolean;
}

function getOwnerInfo(node: IHeapNode): {name: string; edge: string} {
  if (!node.hasPathEdge) return {name: '(root)', edge: ''};
  const pathEdge: IHeapEdge | null = node.pathEdge;
  if (!pathEdge) return {name: '(unknown)', edge: ''};

  const from = pathEdge.fromNode;
  const edgeName = String(pathEdge.name_or_index);

  if (from.type === 'object' || from.type === 'closure') {
    return {
      name: truncateNodeName(from.name, from.type, from.self_size, 40),
      edge: edgeName,
    };
  }

  if (from.hasPathEdge) {
    const outerEdge: IHeapEdge | null = from.pathEdge;
    if (outerEdge) {
      const outer = outerEdge.fromNode;
      if (outer.type === 'object' || outer.type === 'closure') {
        return {
          name: truncateNodeName(outer.name, outer.type, outer.self_size, 40),
          edge: `${String(outerEdge.name_or_index)}.${edgeName}`,
        };
      }
    }
  }

  return {name: from.name, edge: edgeName};
}

function countEntries(node: IHeapNode): number {
  if (node.name === 'Map' || node.name === 'Set') {
    for (const edge of node.references) {
      if (edge.name_or_index === 'table' && edge.toNode.type === 'array') {
        let nonEmpty = 0;
        for (const e of edge.toNode.references) {
          if (e.toNode.type !== 'hidden' && e.toNode.id > 3) {
            nonEmpty++;
          }
        }
        return node.name === 'Map' ? Math.floor(nonEmpty / 2) : nonEmpty;
      }
    }
    return 0;
  }

  if (node.type === 'object' && node.name === 'Array') {
    return node.edge_count;
  }

  return node.edge_count;
}

function hasWeakRefEntries(node: IHeapNode): boolean {
  for (const edge of node.references) {
    if (edge.toNode.name === 'WeakRef' || edge.toNode.name === 'WeakMap') {
      return true;
    }
    if (edge.name_or_index === 'table' && edge.toNode.type === 'array') {
      for (const te of edge.toNode.references) {
        if (te.toNode.name === 'WeakRef') return true;
      }
    }
  }
  return false;
}

export function registerCacheAnalysis(server: McpServer): void {
  server.tool(
    'memlab_cache_analysis',
    'Detect unbounded caches — Map, Set, and Array objects that are large and likely missing eviction logic. The #1 cause of Node.js memory leaks. Reports entry count, retained size, owner object, and whether entries use WeakRef. Use this after memlab_auto_investigate or memlab_check_health flags suspicious collections.',
    {
      limit: z
        .number()
        .optional()
        .default(15)
        .describe('Maximum number of caches to return (default 15)'),
      min_entries: z
        .number()
        .optional()
        .default(50)
        .describe(
          'Minimum number of entries to consider a collection a potential cache (default 50)',
        ),
      min_retained_size: z
        .number()
        .optional()
        .default(524288)
        .describe('Minimum retained size in bytes (default 512 KB)'),
      collection_types: z
        .array(z.string())
        .optional()
        .default(['Map', 'Set', 'Array'])
        .describe('Collection types to scan (default: Map, Set, Array)'),
    },
    async ({limit, min_entries, min_retained_size, collection_types}) => {
      try {
        const snapshot = getSnapshot();
        const meta = getSnapshotMetadata();
        const totalSize = meta?.totalSize ?? 0;

        const typeSet = new Set(collection_types);
        const caches: CacheEntry[] = [];

        snapshot.nodes.forEach(node => {
          if (node.id <= 3) return;
          if (!typeSet.has(node.name)) return;
          if (node.type !== 'object') return;
          if (node.retainedSize < min_retained_size) return;

          const entryCount = countEntries(node);
          if (entryCount < min_entries) return;

          const owner = getOwnerInfo(node);
          const entry: CacheEntry = {
            nodeId: node.id,
            collectionType: node.name,
            entryCount,
            retainedSize: node.retainedSize,
            selfSize: node.self_size,
            ownerName: owner.name,
            ownerEdge: owner.edge,
            hasWeakRefs: hasWeakRefEntries(node),
          };

          let inserted = false;
          for (let i = 0; i < caches.length; i++) {
            if (entry.retainedSize > caches[i].retainedSize) {
              caches.splice(i, 0, entry);
              inserted = true;
              break;
            }
          }
          if (!inserted) caches.push(entry);
          if (caches.length > limit) caches.length = limit;
        });

        if (caches.length === 0) {
          return toolResult(
            `No unbounded caches found with >= ${min_entries} entries and >= ${formatBytes(min_retained_size)} retained. Try lowering the thresholds.`,
          );
        }

        const headers = [
          'ID',
          'Type',
          'Entries',
          'Retained',
          '% Heap',
          'Owner',
          'Property',
          'Weak?',
        ];
        const rightCols = new Set([2, 3, 4]);
        const rows = caches.map(c => {
          const pct =
            totalSize > 0
              ? ((c.retainedSize / totalSize) * 100).toFixed(1) + '%'
              : '-';
          return [
            `@${c.nodeId}`,
            c.collectionType,
            formatNumber(c.entryCount),
            formatBytes(c.retainedSize),
            pct,
            c.ownerName,
            c.ownerEdge,
            c.hasWeakRefs ? 'Yes' : 'No',
          ];
        });

        const totalRetained = caches.reduce(
          (sum, c) => sum + c.retainedSize,
          0,
        );

        const lines = [
          `Cache analysis: ${caches.length} potential unbounded cache(s), ${formatBytes(totalRetained)} total retained`,
          '',
          markdownTable(headers, rows, rightCols),
          '',
          '**Risk indicators:**',
          '- **Weak? = No** means entries are strongly held and will never be evicted by GC',
          '- High entry count with no eviction suggests unbounded growth',
          '- Check if the owner has `clear()`, `delete()`, or LRU logic',
          '',
          '**Suggested next steps:**',
        ];

        const top = caches[0];
        lines.push(
          `- Inspect largest cache: \`memlab_object_shape(${top.nodeId})\``,
          `- See what it retains: \`memlab_dominator_subtree(${top.nodeId})\``,
          `- Trace its retainer: \`memlab_retainer_trace(${top.nodeId})\``,
          `- Check for common patterns: \`memlab_retainer_summary\` with node_ids from the top caches`,
        );

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
