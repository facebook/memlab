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
import type {IHeapNode, HeapNodeIdSet} from '@memlab/core';
import memlabCore from '@memlab/core';
const {utils, NumericSet} = memlabCore;
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  errorResult,
  toolResult,
  suggestionsSuppressed,
} from '../utils.js';

interface ShapeGroup {
  properties: string[];
  count: number;
  totalSelfSize: number;
  rawRetained: number;
  nodeIds: HeapNodeIdSet | null;
  exampleNodeId: number;
}

function getPropertyNames(node: IHeapNode): string[] | null {
  const names: string[] = [];
  for (const edge of node.references) {
    if (edge.type === 'property') {
      names.push(String(edge.name_or_index));
    }
  }
  if (names.length === 0) return null;
  names.sort();
  return names;
}

export function registerShapeHistogram(server: McpServer): void {
  server.tool(
    'memlab_shape_histogram',
    'Group objects by their property structure (shape/hidden class). Objects with the same set of property names are grouped together, revealing distinct record types. Much more useful than class_histogram when most objects are generic "Object" — this tells you exactly what data structures exist and how much memory each shape consumes. Essential for data-heavy apps where millions of "Object" instances hide 3-5 distinct record shapes. ' +
      'By DEFAULT retained size per shape is reported as a cheap RANGE (lower = Σ self size, upper = Σ retained size) from a single O(N) pass; sorting/filtering by retained uses the upper bound. The exact dominator-deduped value needs a per-shape dominator walk that can stall/OOM the server on very large heaps — pass `exact_retained_size:true` ONLY when the user explicitly asks for it.',
    {
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of shapes to return (default 20)'),
      min_count: z
        .number()
        .optional()
        .default(2)
        .describe('Minimum instance count to include (default 2)'),
      min_retained_size: z
        .number()
        .optional()
        .describe(
          'Minimum aggregate retained size in bytes to include (e.g., 1048576 for 1 MB)',
        ),
      class_name: z
        .string()
        .optional()
        .describe(
          'Filter to objects with this constructor name (e.g., "Object"). If omitted, includes all object-type nodes.',
        ),
      sort_by: z
        .enum(['retained_size', 'retained', 'count', 'self_size', 'self'])
        .optional()
        .default('retained_size')
        .describe(
          'Sort order: "retained_size" (default; alias "retained" — uses the upper-bound retained unless exact_retained_size is set), "count" (instance count — find accumulation patterns), or "self_size" (alias "self").',
        ),
      exact_retained_size: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Compute the EXACT dominator-deduped retained size per shape via aggregateDominatorMetrics. DEFAULT false: report a retained-size range instead (lower = Σ self size, upper = Σ raw retained) from the O(N) pass; sorting/filtering by retained uses the upper bound. Set true ONLY on explicit user request — the exact walk can be very slow or time out on huge heaps.',
        ),
    },
    async ({
      limit,
      min_count,
      min_retained_size,
      class_name,
      sort_by,
      exact_retained_size,
    }) => {
      try {
        // Normalize sort aliases so the vocabulary matches other tools.
        const sort =
          sort_by === 'retained'
            ? 'retained_size'
            : sort_by === 'self'
              ? 'self_size'
              : sort_by;
        const snapshot = getSnapshot();
        const shapeMap = new Map<string, ShapeGroup>();

        snapshot.nodes.forEach(node => {
          if (node.type !== 'object') return;
          if (node.id <= 3) return;
          if (class_name && node.name !== class_name) return;

          const props = getPropertyNames(node);
          if (!props) return;

          const key = props.join(',');
          const existing = shapeMap.get(key);
          if (existing) {
            existing.count++;
            existing.totalSelfSize += node.self_size;
            existing.rawRetained += node.retainedSize;
            if (existing.nodeIds) existing.nodeIds.add(node.id);
          } else {
            shapeMap.set(key, {
              properties: props,
              count: 1,
              totalSelfSize: node.self_size,
              rawRetained: node.retainedSize,
              // Per-node ids only needed for the opt-in exact dominator walk.
              nodeIds: exact_retained_size ? new NumericSet([node.id]) : null,
              exampleNodeId: node.id,
            });
          }
        });

        const filtered = [...shapeMap.values()].filter(
          g => g.count >= min_count,
        );

        // By DEFAULT skip the exact dominator walk (the part that stalls the
        // server on huge heaps) and rank/filter by the upper-bound raw retained
        // sum; only compute exact dominator-deduped retained when asked.
        const withRetained = filtered.map(g => {
          let exact: number | null = null;
          if (exact_retained_size && g.nodeIds) {
            exact = utils.aggregateDominatorMetrics(
              g.nodeIds,
              snapshot,
              () => true,
              (node: IHeapNode) => node.retainedSize,
            );
          }
          const retainedRank = exact ?? g.rawRetained;
          return {...g, exact, retainedRank};
        });

        let finalList = withRetained;
        if (min_retained_size != null) {
          finalList = finalList.filter(
            g => g.retainedRank >= min_retained_size,
          );
        }

        if (sort === 'count') {
          finalList.sort((a, b) => b.count - a.count);
        } else if (sort === 'self_size') {
          finalList.sort((a, b) => b.totalSelfSize - a.totalSelfSize);
        } else {
          finalList.sort((a, b) => b.retainedRank - a.retainedRank);
        }
        finalList = finalList.slice(0, limit);

        if (finalList.length === 0) {
          return toolResult(
            'No object shapes found matching the criteria. Try lowering min_count or removing class_name filter.',
          );
        }

        const lines: string[] = [
          `## Object Shape Histogram`,
          `${formatNumber(shapeMap.size)} distinct shapes found, showing top ${finalList.length}`,
          '',
        ];

        for (let i = 0; i < finalList.length; i++) {
          const g = finalList[i];
          const propsDisplay =
            g.properties.length <= 8
              ? `{${g.properties.join(', ')}}`
              : `{${g.properties.slice(0, 6).join(', ')}, … +${g.properties.length - 6} more}`;

          const retainedStr = exact_retained_size
            ? `${formatBytes(g.exact ?? 0)} retained, ${formatBytes(g.totalSelfSize)} self`
            : `retained ∈ [${formatBytes(g.totalSelfSize)}, ≤ ${formatBytes(g.rawRetained)}]`;
          lines.push(
            `${i + 1}. **${propsDisplay}** — ${formatNumber(g.count)} instances, ${retainedStr}`,
          );
          lines.push(`   Example: @${g.exampleNodeId}`);
        }

        if (!exact_retained_size) {
          lines.push(
            '',
            "_Retained shown as a range `[lower, ≤ upper]`: lower = Σ self size (objects' own bytes), upper = Σ retained size (double-counts subtrees shared between instances on the dominator tree). The exact dominator-deduped value needs a per-shape dominator walk that can stall or time out on large heaps — pass `exact_retained_size:true` for it._",
          );
        }

        if (!suggestionsSuppressed()) {
          lines.push('', '**Suggested next steps:**');
          const top = finalList[0];
          lines.push(
            `- Inspect example: \`memlab_object_shape(${top.exampleNodeId})\``,
          );
          lines.push(
            `- Distribution of a property's values: \`memlab_property_distribution\` (cardinality + top values)`,
          );
          lines.push(
            `- Trace retention: \`memlab_retainer_trace(${top.exampleNodeId})\``,
          );
          if (finalList.length > 1) {
            lines.push(
              `- Compare shapes: \`memlab_object_shape\` on examples from different shapes`,
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
