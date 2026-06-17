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
          // V8 represents these as distinct node *types*, not as `string`
          // nodes with a special name. A sliced string shares the backing
          // store of a parent; a concatenated (cons) string references two
          // halves via `first`/`second`.
          const isSliced = node.type === 'sliced string';
          const isConcat = node.type === 'concatenated string';

          if (!isSliced && !isConcat) return;

          if (isSliced) {
            slicedCount++;
            slicedTotalSize += node.self_size;
          } else {
            concatCount++;
            concatTotalSize += node.self_size;
          }

          // Only sliced strings keep a single large parent alive through the
          // `parent` edge. (Cons strings split across two halves and rarely
          // pin one oversized backing buffer, so they're counted but not
          // attributed to a parent here.)
          if (!isSliced) return;
          for (const edge of node.references) {
            if (String(edge.name_or_index) !== 'parent') continue;
            const target = edge.toNode;
            if (!target.isString) continue;

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
            break;
          }
        });

        if (slicedCount === 0 && concatCount === 0) {
          return toolResult(
            'No sliced or concatenated strings found in the snapshot.',
          );
        }

        const allParents = [...parentMap.values()];
        const totalPinnedBytes = allParents.reduce(
          (sum, p) => sum + p.self_size,
          0,
        );

        // Don't go silent when `min_parent_size` filters everything out. On the
        // common "many medium parents" case (each parent sub-MB but thousands of
        // them, e.g. ~250 KB JSON records) the filter used to hide every row and
        // the tool reported nothing actionable. Fall back to the largest parents
        // with a note, and ALWAYS report the aggregate bytes pinned so the "lots
        // of small parents" case is visible (Feedback round 4 §3a).
        let parents = allParents;
        let filteredNote = '';
        if (min_parent_size != null) {
          const filtered = allParents.filter(
            p => p.self_size >= min_parent_size,
          );
          if (filtered.length > 0) {
            parents = filtered;
          } else {
            filteredNote = ` (no parent ≥ ${formatBytes(min_parent_size)}; showing the largest instead)`;
          }
        }
        parents = [...parents].sort((a, b) => b.self_size - a.self_size);
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
        if (allParents.length > 0) {
          lines.push(
            `**Total parent bytes pinned by slices:** ${formatBytes(totalPinnedBytes)} across ${formatNumber(allParents.length)} parent string(s) — substrings keep these alive even when each individual parent is small.`,
          );
        }
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
          lines.push(
            `### Top parent strings (keeping slices alive)${filteredNote}`,
          );
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
