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
import type {IHeapNode} from '@memlab/core';
import memlabCore from '@memlab/core';
const {utils, NumericSet} = memlabCore;
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  filterLargestObjects,
  serializeNodeSummary,
  formatNodeSummaryTable,
  formatNumber,
  formatBytes,
  errorResult,
  toolResult,
} from '../utils.js';

export function registerFindNodesByClass(server: McpServer): void {
  server.tool(
    'memlab_find_nodes_by_class',
    'Find heap nodes by constructor/class name. Matches ANY node type by default (object, closure, array, string, native, …) — pass node_type to narrow. Ordering is controlled by order: the biggest by retained size (default), or the newest by node id. If the exact name matches nothing, reports near-miss names and the types they exist under instead of a bare "not found". Follow up with memlab_retainer_trace on a result node to see why it is retained, memlab_get_references to inspect its properties, or memlab_retainer_summary to find common retainer patterns across all instances.',
    {
      class_name: z
        .string()
        .describe('The constructor or class name to search for'),
      order: z
        .enum(['retained_size', 'newest'])
        .optional()
        .default('retained_size')
        .describe(
          'How to pick which instances to show. "retained_size" (default) shows the biggest. "newest" shows the highest node ids — V8 assigns ids in allocation order, so within one snapshot this approximates the most recently allocated instances. When a class has grown from N to 10N across a ladder, the accumulating tail is what you want to inspect, and the biggest instances are usually the oldest — not the ones that are piling up. Approximate: ids are an allocation-order proxy, not a timestamp.',
        ),
      node_type: z
        .string()
        .optional()
        .describe(
          'Restrict to a single heap node type (e.g. "object", "closure", "array", "string", "native"). Omit to match every type — which is the default because class names surfaced by other tools (memlab_sequence_analysis reports "type::name") are frequently closures or arrays, not objects.',
        ),
      output_mode: z
        .enum(['full', 'count', 'ids'])
        .optional()
        .default('full')
        .describe(
          'Output verbosity: "full" returns node summaries (default), "count" returns only total count and aggregate retained size, "ids" returns only node IDs. "full" and "ids" are both ordered by the "order" parameter, not always by retained size.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(20)
        .describe('Maximum number of results (default 20)'),
    },
    async ({class_name, node_type, output_mode, limit, order}) => {
      try {
        const snapshot = getSnapshot();
        // Historically this hard-filtered `type === 'object'`, so closures,
        // arrays, strings and natives were invisible: a class reported as a top
        // grower by memlab_sequence_analysis (which groups by `type::name`)
        // could return "No objects found" here, e.g. the closure `setValues_$0`.
        // Default to every type and let the caller narrow explicitly.
        const classFilter = (node: IHeapNode) =>
          node.name === class_name &&
          (node_type == null || node.type === node_type);

        // Zero exact matches is usually a type filter or a near-miss name, not
        // an empty heap — say which, so the caller does not conclude the class
        // is absent.
        const notFound = (): string => {
          const byType = new Map<string, number>();
          const similar = new Map<string, number>();
          const needle = class_name.toLowerCase();
          snapshot.nodes.forEach(node => {
            if (node.name === class_name) {
              byType.set(node.type, (byType.get(node.type) ?? 0) + 1);
            } else if (
              node.name.length < 120 &&
              node.name.toLowerCase().includes(needle)
            ) {
              const k = `${node.name} (${node.type})`;
              similar.set(k, (similar.get(k) ?? 0) + 1);
            }
          });
          if (byType.size > 0) {
            const got = [...byType.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([t, n]) => `${t} (${formatNumber(n)})`)
              .join(', ');
            return `No nodes named "${class_name}" with node_type="${node_type ?? 'any'}". It DOES exist under: ${got}. Re-run without node_type, or with the matching one.`;
          }
          if (similar.size > 0) {
            const top = [...similar.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([k, n]) => `${k} ×${formatNumber(n)}`)
              .join(', ');
            return `No nodes named exactly "${class_name}". Similar names present: ${top}`;
          }
          return `No nodes found with class "${class_name}" (no similar names either — check the snapshot is the one you expect).`;
        };

        if (output_mode === 'count') {
          let totalCount = 0;
          let totalSelf = 0;
          const nodeIds = new NumericSet();
          snapshot.nodes.forEach(node => {
            if (!classFilter(node)) return;
            totalCount++;
            totalSelf += node.self_size;
            nodeIds.add(node.id);
          });
          if (totalCount === 0) {
            return toolResult(notFound());
          }
          // Dominator-aware aggregate: instances of a class often nest on the
          // dominator tree (e.g. a Foo retaining another Foo), so a raw sum of
          // retainedSize would double-count and can exceed 100% of heap.
          const totalRetained = utils.aggregateDominatorMetrics(
            nodeIds,
            snapshot,
            () => true,
            (node: IHeapNode) => node.retainedSize,
          );
          return toolResult(
            `"${class_name}": ${formatNumber(totalCount)} instances, ${formatBytes(totalSelf)} total self size, ${formatBytes(totalRetained)} aggregate retained size (dominator-deduplicated)`,
          );
        }

        let nodes: IHeapNode[];
        if (order === 'newest') {
          // Highest node ids = latest allocated within this snapshot. Keep a
          // bounded top-N rather than collecting every match and sorting, so a
          // class with a million instances does not materialize a huge array.
          // Relies on the schema's integer `limit >= 1`: a fractional limit
          // never satisfies `length === limit`, and `limit <= 0` would fall
          // through to the eviction branch and keep one node anyway.
          const newest: IHeapNode[] = [];
          let minKept = -1;
          snapshot.nodes.forEach(node => {
            if (!classFilter(node)) return;
            if (newest.length < limit) {
              newest.push(node);
              if (newest.length === limit) {
                newest.sort((a, b) => a.id - b.id);
                minKept = newest[0].id;
              }
              return;
            }
            if (node.id <= minKept) return;
            newest[0] = node;
            newest.sort((a, b) => a.id - b.id);
            minKept = newest[0].id;
          });
          nodes = newest.sort((a, b) => b.id - a.id);
        } else {
          nodes = filterLargestObjects(snapshot, classFilter, limit);
        }

        let totalCount = 0;
        if (nodes.length === limit) {
          snapshot.nodes.forEach(node => {
            if (classFilter(node)) totalCount++;
          });
        } else {
          totalCount = nodes.length;
        }

        if (nodes.length === 0) {
          return toolResult(notFound());
        }

        if (output_mode === 'ids') {
          return toolResult(
            `"${class_name}": ${formatNumber(totalCount)} total instances (showing ${nodes.length} IDs by ${order === 'newest' ? 'node id — newest first' : 'retained size'})\n\nIDs: ${nodes.map(n => n.id).join(', ')}`,
          );
        }

        const summaries = nodes.map(serializeNodeSummary);
        const countNote =
          totalCount > nodes.length
            ? ` (${formatNumber(totalCount)} total, showing ${order === 'newest' ? `the ${nodes.length} newest by node id` : `top ${nodes.length} by retained size`})`
            : '';
        return toolResult(
          `Found ${formatNumber(totalCount)} "${class_name}" objects${countNote}\n\n${formatNodeSummaryTable(summaries)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
