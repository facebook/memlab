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
import {getSnapshot} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  textResult,
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

interface CollectionStat {
  collection: IHeapNode;
  stale_item_count: number;
  stale_retained_size: number;
  total_children: number;
}

export function registerStaleCollections(server: McpServer): void {
  server.tool(
    'memlab_stale_collections',
    'Find Map, Set, and Array collections holding references to detached DOM nodes or unmounted React Fiber nodes. These collections prevent garbage collection of stale objects.',
    {
      limit: z
        .number()
        .optional()
        .default(15)
        .describe('Maximum number of results (default 15)'),
    },
    async ({limit}) => {
      try {
        const snapshot = getSnapshot();
        const results: CollectionStat[] = [];

        snapshot.nodes.forEach(node => {
          if (!isCollectionNode(node)) return;

          const children = getCollectionChildren(node);
          let staleCount = 0;
          let staleRetainedSize = 0;
          let totalChildren = 0;

          for (const edge of children) {
            totalChildren++;
            if (isStaleNode(edge.toNode)) {
              staleCount++;
              staleRetainedSize += edge.toNode.retainedSize;
            }
          }

          if (staleCount > 0) {
            results.push({
              collection: node,
              stale_item_count: staleCount,
              stale_retained_size: staleRetainedSize,
              total_children: totalChildren,
            });
          }
        });

        // Sort by stale retained size descending
        results.sort((a, b) => b.stale_retained_size - a.stale_retained_size);
        const topResults = results.slice(0, limit);

        if (topResults.length === 0) {
          return textResult('No stale collections found.');
        }
        const headers = [
          'Collection ID',
          'Name',
          'Stale / Total',
          'Stale Retained',
        ];
        const rightCols = new Set([2, 3]);
        const rows = topResults.map(r => [
          `@${r.collection.id}`,
          r.collection.name,
          `${formatNumber(r.stale_item_count)} / ${formatNumber(r.total_children)}`,
          formatBytes(r.stale_retained_size),
        ]);
        return textResult(
          `Stale collections (${topResults.length} found)\n\n${markdownTable(headers, rows, rightCols)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
