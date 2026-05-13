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
import {
  formatBytes,
  formatNumber,
  markdownTable,
  truncateNodeName,
  errorResult,
  textResult,
  toolResult,
} from '../utils.js';

interface ParentStats {
  id: number;
  name: string;
  self_size: number;
  retained_size: number;
  sliced_ref_count: number;
  sliced_total_size: number;
}

export function registerSlicedStrings(server: McpServer): void {
  server.tool(
    'memlab_sliced_strings',
    'Find V8 sliced and concatenated string nodes and identify the parent strings they reference. Sliced strings share backing storage with a parent string — if the parent is a large string (e.g., a multi-MB CSV response), all slices keep the entire parent alive. This is a common cause of hidden memory leaks where small substring references retain massive parent strings. Shows parent strings ranked by parent string size.',
    {
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of parent strings to return (default 20)'),
      min_parent_size: z
        .number()
        .optional()
        .describe(
          'Minimum parent string self size in bytes to include. Use to focus on large parents (e.g., 1048576 for 1 MB).',
        ),
    },
    async ({limit, min_parent_size}) => {
      try {
        const snapshot = getSnapshot();

        let slicedCount = 0;
        let concatCount = 0;
        let slicedTotalSize = 0;
        let concatTotalSize = 0;

        // Map from parent node ID -> stats
        const parentMap = new Map<number, ParentStats>();

        snapshot.nodes.forEach(node => {
          const isSliced =
            node.type === 'string' && node.name === 'system / SlicedString';
          const isConcat =
            node.type === 'concatenated string' ||
            (node.type === 'string' && node.name === 'system / ConsString');

          if (!isSliced && !isConcat) return;

          if (isSliced) {
            slicedCount++;
            slicedTotalSize += node.self_size;
          } else {
            concatCount++;
            concatTotalSize += node.self_size;
          }

          // For sliced strings, follow the 'parent' edge to find the
          // backing string
          for (const edge of node.references) {
            const target = edge.toNode;
            if (target.type !== 'string') continue;
            // Skip other sliced/concat strings — find the actual parent
            if (
              target.name === 'system / SlicedString' ||
              target.name === 'system / ConsString'
            ) {
              continue;
            }

            const existing = parentMap.get(target.id);
            if (existing) {
              existing.sliced_ref_count++;
              existing.sliced_total_size += node.self_size;
            } else {
              parentMap.set(target.id, {
                id: target.id,
                name: target.name,
                self_size: target.self_size,
                retained_size: target.retainedSize,
                sliced_ref_count: 1,
                sliced_total_size: node.self_size,
              });
            }
          }
        });

        if (slicedCount === 0 && concatCount === 0) {
          return toolResult(
            'No sliced or concatenated strings found in the snapshot.',
          );
        }

        let parents = [...parentMap.values()];
        if (min_parent_size != null) {
          parents = parents.filter(p => p.self_size >= min_parent_size);
        }
        parents.sort((a, b) => b.self_size - a.self_size);
        const topParents = parents.slice(0, limit);

        const lines: string[] = [];
        lines.push(
          `**Sliced strings:** ${formatNumber(slicedCount)} nodes (${formatBytes(slicedTotalSize)} self size)`,
        );
        if (concatCount > 0) {
          lines.push(
            `**Concatenated strings:** ${formatNumber(concatCount)} nodes (${formatBytes(concatTotalSize)} self size)`,
          );
        }
        lines.push(
          `**Unique parent strings referenced:** ${formatNumber(parentMap.size)}`,
        );
        lines.push('');

        if (topParents.length > 0) {
          const headers = [
            'Parent ID',
            'Content',
            'Parent Size',
            'Retained',
            'Sliced Refs',
            'Slices Size',
          ];
          const rightCols = new Set([2, 3, 4, 5]);
          const rows = topParents.map(p => [
            `@${p.id}`,
            truncateNodeName(p.name, 'string', p.self_size, 80),
            formatBytes(p.self_size),
            formatBytes(p.retained_size),
            formatNumber(p.sliced_ref_count),
            formatBytes(p.sliced_total_size),
          ]);
          lines.push('### Top parent strings (keeping slices alive)');
          lines.push('');
          lines.push(markdownTable(headers, rows, rightCols));

          const largeMB = topParents.filter(p => p.self_size >= 1024 * 1024);
          if (largeMB.length > 0) {
            const totalLarge = largeMB.reduce((s, p) => s + p.self_size, 0);
            lines.push('');
            lines.push(
              `**⚠ ${largeMB.length} parent string(s) > 1 MB (${formatBytes(totalLarge)} total).** Small substrings (slices) are keeping these large strings alive. Consider copying substring values instead of slicing, or nullifying references to the source data after extraction.`,
            );
          }
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
