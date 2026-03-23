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
import {getSnapshot} from '../heap-state.js';
import {formatBytes, errorResult, textResult} from '../utils.js';

export function registerDuplicatedStrings(server: McpServer): void {
  server.tool(
    'memlab_duplicated_strings',
    'Find duplicated string instances in the heap. Shows strings that appear multiple times, ranked by total retained size — a common source of memory waste.',
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

        // Build frequency map: string value -> { count, totalSize, exampleIds }
        const stringMap = new Map<
          string,
          {count: number; total_size: number; example_node_ids: number[]}
        >();

        snapshot.nodes.forEach(node => {
          if (node.type !== 'string') return;
          // Skip sliced strings (they share backing storage)
          if (node.name === 'system / SlicedString') return;

          const strNode = node.toStringNode();
          if (!strNode) return;

          const value = strNode.stringValue;
          const entry = stringMap.get(value);
          if (entry) {
            entry.count++;
            entry.total_size += node.retainedSize;
            if (entry.example_node_ids.length < 3) {
              entry.example_node_ids.push(node.id);
            }
          } else {
            stringMap.set(value, {
              count: 1,
              total_size: node.retainedSize,
              example_node_ids: [node.id],
            });
          }
        });

        // Filter to only duplicated strings (count > 1) and rank by total size
        const duplicated = Array.from(stringMap.entries())
          .filter(([, stats]) => stats.count > 1)
          .sort((a, b) => b[1].total_size - a[1].total_size)
          .slice(0, limit)
          .map(([value, stats]) => ({
            value: value.length > 200 ? value.substring(0, 200) + '...' : value,
            count: stats.count,
            total_size: stats.total_size,
            total_size_formatted: formatBytes(stats.total_size),
            example_node_ids: stats.example_node_ids,
          }));

        if (duplicated.length === 0) {
          return textResult('No duplicated strings found.');
        }
        const lines = duplicated.map((d, i) => {
          const val =
            d.value.length > 80 ? d.value.slice(0, 80) + '...' : d.value;
          const nodeIds = d.example_node_ids.map(id => `@${id}`).join(', ');
          return `${i + 1}. "${val}" x ${d.count} copies, ${d.total_size_formatted} total (nodes: ${nodeIds})`;
        });
        return textResult(
          `Duplicated strings (${duplicated.length} entries):\n\n${lines.join('\n')}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
