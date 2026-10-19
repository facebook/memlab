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
import {pageInfo, structuredResult} from '../structured.js';
import {offsetParam, pageFooter, paginate} from '../pagination.js';
import {getSnapshot} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  errorResult,
  toolResult,
  suggestionsSuppressed,
  makeNamePatternTest,
} from '../utils.js';

interface ShapeGroup {
  properties: string[];
  count: number;
  totalSelfSize: number;
  rawRetained: number;
  nodeIds: HeapNodeIdSet | null;
  exampleNodeId: number;
  /** `exclusive_retained`: bytes credited to this shape and no other. */
  exclusive: number;
  index: number;
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
      offset: offsetParam(),
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
      name_pattern: z
        .string()
        .optional()
        .describe(
          'Filter constructor names by pattern before grouping by shape — a case-insensitive regular expression, or a plain substring when the pattern is not valid regex (e.g. "blink::UndoStep", "Detached", "^WA"). Answering "is class X present?" this way costs one row instead of a whole table.',
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
      exclusive_retained: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Report one EXCLUSIVE retained figure per shape from a single extra O(N) pass: every node counts once, under the nearest instance of any shape (after the class and name filters) on its dominator chain, itself included. The figures add up across shapes, so they partition the heap by record type — the per-shape range and `exact_retained_size` both count a nested record in its own shape AND in every shape above it. Sorting and filtering by retained use it.',
        ),
    },
    async ({
      limit,
      offset,
      min_count,
      min_retained_size,
      class_name,
      name_pattern,
      sort_by,
      exact_retained_size,
      exclusive_retained,
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
        const nameMatches = makeNamePatternTest(name_pattern);
        const shapeMap = new Map<string, ShapeGroup>();
        // Exclusive figures supersede the exact per-shape walk, so the
        // expensive walk is skipped when both are asked for.
        const wantExact = exact_retained_size && !exclusive_retained;
        // nodeIndex -> its shape group, for the exclusive pass.
        const groupOf: ShapeGroup[] = [];
        const instanceOf = exclusive_retained
          ? new Int32Array(snapshot.nodes.length).fill(-1)
          : null;

        snapshot.nodes.forEach(node => {
          if (node.type !== 'object') return;
          if (node.id <= 3) return;
          if (class_name && node.name !== class_name) return;
          if (!nameMatches(node.name)) return;

          const props = getPropertyNames(node);
          if (!props) return;

          const key = props.join(',');
          let group = shapeMap.get(key);
          if (group) {
            group.count++;
            group.totalSelfSize += node.self_size;
            group.rawRetained += node.retainedSize;
            if (group.nodeIds) group.nodeIds.add(node.id);
          } else {
            group = {
              properties: props,
              count: 1,
              totalSelfSize: node.self_size,
              rawRetained: node.retainedSize,
              // Per-node ids only needed for the opt-in exact dominator walk.
              nodeIds: wantExact ? new NumericSet([node.id]) : null,
              exampleNodeId: node.id,
              exclusive: 0,
              index: groupOf.length,
            };
            shapeMap.set(key, group);
            groupOf.push(group);
          }
          if (instanceOf) instanceOf[node.nodeIndex] = group.index;
        });

        let exclusiveTotal = 0;
        // Nodes whose dominator chain outran the hop cap: credited nowhere,
        // and said so in the footer.
        let capped = 0;
        let cappedBytes = 0;
        if (instanceOf) {
          // Memoised walk up the dominator tree: -1 unresolved, -2 no shape,
          // -3 under a chain that outran the hop cap (cached too, so a deep
          // chain is walked once, not once per node hanging off it).
          const memo = new Int32Array(snapshot.nodes.length).fill(-1);
          const chain: number[] = [];
          snapshot.nodes.forEach((node: IHeapNode) => {
            if (node.id <= 3) return;
            let cur: IHeapNode | null = node;
            let answer = -2;
            // False only when the hop cap cut the walk short: then the chain's
            // real answer is unknown and must not be cached as "no shape".
            let resolved = false;
            chain.length = 0;
            for (let hops = 0; cur != null && hops < 10000; hops++) {
              const i = cur.nodeIndex;
              if (instanceOf[i] >= 0) {
                answer = instanceOf[i];
                resolved = true;
                break;
              }
              if (memo[i] !== -1) {
                answer = memo[i];
                resolved = answer !== -3;
                break;
              }
              chain.push(i);
              const dom: IHeapNode | null = cur.dominatorNode ?? null;
              if (dom == null || dom.nodeIndex === i) {
                resolved = true;
                break;
              }
              cur = dom;
            }
            if (!resolved) answer = -3;
            for (const i of chain) memo[i] = answer;
            if (answer === -3) {
              capped++;
              cappedBytes += node.self_size;
            }
            if (answer >= 0) {
              groupOf[answer].exclusive += node.self_size;
              exclusiveTotal += node.self_size;
            }
          });
        }

        const filtered = [...shapeMap.values()].filter(
          g => g.count >= min_count,
        );

        // By DEFAULT skip the exact dominator walk (the part that stalls the
        // server on huge heaps) and rank/filter by the upper-bound raw retained
        // sum; only compute exact dominator-deduped retained when asked.
        const withRetained = filtered.map(g => {
          let exact: number | null = null;
          if (wantExact && g.nodeIds) {
            exact = utils.aggregateDominatorMetrics(
              g.nodeIds,
              snapshot,
              () => true,
              (node: IHeapNode) => node.retainedSize,
            );
          }
          const retainedRank = exclusive_retained
            ? g.exclusive
            : (exact ?? g.rawRetained);
          return {...g, exact, retainedRank};
        });

        let finalList = withRetained;
        if (min_retained_size != null) {
          finalList = finalList.filter(
            g => g.retainedRank >= min_retained_size,
          );
        }

        // Ties by example node id, so the same offset pages the same way.
        const tie = (a: {exampleNodeId: number}, b: {exampleNodeId: number}) =>
          a.exampleNodeId - b.exampleNodeId;
        if (sort === 'count') {
          finalList.sort((a, b) => b.count - a.count || tie(a, b));
        } else if (sort === 'self_size') {
          finalList.sort(
            (a, b) => b.totalSelfSize - a.totalSelfSize || tie(a, b),
          );
        } else {
          finalList.sort(
            (a, b) => b.retainedRank - a.retainedRank || tie(a, b),
          );
        }
        const page = paginate(finalList, offset, limit);
        finalList = page.items;

        if (finalList.length === 0) {
          return toolResult(
            'No object shapes found matching the criteria. Try lowering min_count or removing class_name filter.',
          );
        }

        const lines: string[] = [
          ...(page.notice != null ? [page.notice, ''] : []),
          `## Object Shape Histogram`,
          `${formatNumber(shapeMap.size)} distinct shapes found. ${pageFooter(page, 'matching shapes')}`,
          '',
        ];

        for (let i = 0; i < finalList.length; i++) {
          const g = finalList[i];
          const propsDisplay =
            g.properties.length <= 8
              ? `{${g.properties.join(', ')}}`
              : `{${g.properties.slice(0, 6).join(', ')}, … +${g.properties.length - 6} more}`;

          const retainedStr = exclusive_retained
            ? `${formatBytes(g.exclusive)} exclusive, ${formatBytes(g.totalSelfSize)} self`
            : exact_retained_size
              ? `${formatBytes(g.exact ?? 0)} retained, ${formatBytes(g.totalSelfSize)} self`
              : `retained ∈ [${formatBytes(g.totalSelfSize)}, ≤ ${formatBytes(g.rawRetained)}]`;
          lines.push(
            `${page.offset + i + 1}. **${propsDisplay}** — ${formatNumber(g.count)} instances, ${retainedStr}`,
          );
          lines.push(`   Example: @${g.exampleNodeId}`);
        }

        if (exclusive_retained) {
          lines.push(
            '',
            `_**Exclusive** credits every node to the nearest instance of any shape on its dominator chain, so the figures add up: all ${formatNumber(shapeMap.size)} shapes together, including those below \`min_count\` or past \`limit\`, hold ${formatBytes(exclusiveTotal)}; the rows above hold ${formatBytes(finalList.reduce((sum, g) => sum + g.exclusive, 0))} of it. A record nested in another counts under its own shape only._` +
              (capped > 0
                ? `\n⚠ ${formatNumber(capped)} node(s) (${formatBytes(cappedBytes)}) sit under a dominator chain deeper than 10,000 hops and are credited to no shape.`
                : ''),
          );
        } else if (!exact_retained_size) {
          lines.push(
            '',
            "_Retained shown as a range `[lower, ≤ upper]`: lower = Σ self size (objects' own bytes), upper = Σ retained size (double-counts subtrees shared between instances on the dominator tree). The exact dominator-deduped value needs a per-shape dominator walk that can stall or time out on large heaps — pass `exact_retained_size:true` for it._",
          );
          // A range is only safe to quote when its ends agree. Three different
          // figures have been published for one object before the right one was
          // measured, so say WHEN the choice of end changes the story rather
          // than leaving the reader to notice.
          const widest = finalList.reduce(
            (w, g) => {
              const ratio =
                g.totalSelfSize > 0 ? g.rawRetained / g.totalSelfSize : 1;
              return ratio > w.ratio ? {ratio, g} : w;
            },
            {ratio: 0, g: finalList[0]},
          );
          if (widest.ratio >= 2 && widest.g != null) {
            lines.push(
              `⚠ The widest range here spans **${widest.ratio.toFixed(1)}×** ` +
                `(${formatBytes(widest.g.totalSelfSize)} → ${formatBytes(widest.g.rawRetained)}). ` +
                'Which end you quote changes the finding, so do not carry either ' +
                'number into a write-up as "the size" — re-run with ' +
                '`exact_retained_size:true`, or size the specific instance with ' +
                '`memlab_dominator_attribution`.',
            );
          }
        }

        if (!suggestionsSuppressed('memlab_shape_histogram')) {
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

        return structuredResult(lines.join('\n'), {
          sort_by: sort,
          shapes: finalList.map(g => ({
            properties: g.properties,
            count: g.count,
            self_size: g.totalSelfSize,
            example_id: g.exampleNodeId,
            ...(exclusive_retained ? {exclusive_size: g.exclusive} : {}),
            ...(exact_retained_size
              ? {retained_size: g.exact ?? 0}
              : {retained_upper_bound: g.rawRetained}),
          })),
          pagination: pageInfo(page),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
