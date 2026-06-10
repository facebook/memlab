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
    'Find heap objects by constructor/class name. Returns matching objects sorted by retained size. Follow up with memlab_retainer_trace on a result node to see why it is retained, memlab_get_references to inspect its properties, or memlab_retainer_summary to find common retainer patterns across all instances.',
    {
      class_name: z
        .string()
        .describe('The constructor or class name to search for'),
      output_mode: z
        .enum(['full', 'count', 'ids'])
        .optional()
        .default('full')
        .describe(
          'Output verbosity: "full" returns node summaries sorted by retained size (default), "count" returns only total count and aggregate retained size, "ids" returns only node IDs sorted by retained size',
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of results (default 20)'),
    },
    async ({class_name, output_mode, limit}) => {
      try {
        const snapshot = getSnapshot();
        const classFilter = (node: IHeapNode) =>
          node.name === class_name && node.type === 'object';

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
            return toolResult(`No objects found with class "${class_name}"`);
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

        const nodes = filterLargestObjects(snapshot, classFilter, limit);

        let totalCount = 0;
        if (nodes.length === limit) {
          snapshot.nodes.forEach(node => {
            if (classFilter(node)) totalCount++;
          });
        } else {
          totalCount = nodes.length;
        }

        if (nodes.length === 0) {
          return toolResult(`No objects found with class "${class_name}"`);
        }

        if (output_mode === 'ids') {
          return toolResult(
            `"${class_name}": ${formatNumber(totalCount)} total instances (showing ${nodes.length} IDs by retained size)\n\nIDs: ${nodes.map(n => n.id).join(', ')}`,
          );
        }

        const summaries = nodes.map(serializeNodeSummary);
        const countNote =
          totalCount > nodes.length
            ? ` (${formatNumber(totalCount)} total, showing top ${nodes.length})`
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
