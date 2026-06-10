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
  serializeNodeSummary,
  isNodeWorthInspecting,
  formatNodeSummaryTable,
  formatNumber,
  formatBytes,
  errorResult,
  toolResult,
  makeScanBudget,
  ScanTimeoutError,
} from '../utils.js';

export function registerFindByProperty(server: McpServer): void {
  server.tool(
    'memlab_find_by_property',
    'Find all objects that have a specific property name (outgoing edge). Useful for identifying ' +
      'objects with React internals (__reactFiber$, __reactProps$), custom data structures, or ' +
      'framework-specific markers. Use property_value_node_id for reverse referrer lookup — ' +
      'finding all objects whose named property points to a specific node (e.g., "which objects ' +
      'have their callback property pointing to closure @700467?"). Results sorted by retained size.',
    {
      property_name: z
        .string()
        .describe(
          'The property/edge name to search for (e.g., "__reactFiber$", "cache", "data")',
        ),
      property_value: z
        .string()
        .optional()
        .describe(
          'Filter by the string value of the property target. Exact match by default; prefix with "/" for regex (e.g., "/^Left$/"). Only matches string-type target nodes.',
        ),
      property_value_node_id: z
        .number()
        .optional()
        .describe(
          'Filter by the target node ID of the property. Finds all objects whose named property points to this specific node. ' +
            'Essential for reverse referrer lookup — e.g., find all objects whose "callback" property points to closure @700467.',
        ),
      edge_type: z
        .string()
        .optional()
        .describe(
          'Optional edge type filter (property, element, context, internal)',
        ),
      output_mode: z
        .enum(['full', 'count', 'ids'])
        .optional()
        .default('full')
        .describe(
          'Output verbosity: "full" returns node summaries (default), "count" returns only the total count and aggregate retained size, "ids" returns only node IDs',
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of results (default 20)'),
      timeout_ms: z
        .number()
        .optional()
        .default(45000)
        .describe(
          'Wall-clock budget for the full-heap scan (default 45000). On very large browser heaps the scan returns partial results with a note instead of running for many minutes.',
        ),
    },
    async ({
      property_name,
      property_value,
      property_value_node_id,
      edge_type,
      output_mode,
      limit,
      timeout_ms,
    }) => {
      try {
        const snapshot = getSnapshot();
        const budget = makeScanBudget(timeout_ms);
        let timedOut = false;

        // Use prefix matching for names ending with $ (React dynamic suffixes)
        const isPrefix = property_name.endsWith('$');

        let valueRegex: RegExp | null = null;
        let valueExact: string | null = null;
        if (property_value) {
          if (
            property_value.startsWith('/') &&
            property_value.lastIndexOf('/') > 0
          ) {
            const lastSlash = property_value.lastIndexOf('/');
            const pattern = property_value.slice(1, lastSlash);
            const flags = property_value.slice(lastSlash + 1);
            valueRegex = new RegExp(pattern, flags);
          } else {
            valueExact = property_value;
          }
        }

        const filterDesc =
          `"${property_name}"` +
          (property_value ? ` = "${property_value}"` : '') +
          (property_value_node_id != null
            ? ` -> @${property_value_node_id}`
            : '') +
          (edge_type ? ` (edge type: ${edge_type})` : '');

        const matchesProperty = (node: IHeapNode): boolean => {
          return node.references.some(edge => {
            const edgeName = String(edge.name_or_index);
            const nameMatch = isPrefix
              ? edgeName.startsWith(property_name)
              : edgeName === property_name;
            if (!nameMatch) return false;
            if (edge_type && edge.type !== edge_type) return false;
            if (property_value_node_id != null) {
              if (edge.toNode.id !== property_value_node_id) return false;
            }
            if (valueExact != null || valueRegex != null) {
              const target = edge.toNode;
              if (!target.isString) return false;
              const strNode = target.toStringNode();
              if (!strNode) return false;
              const strVal = strNode.stringValue;
              if (valueExact != null && strVal !== valueExact) return false;
              if (valueRegex != null && !valueRegex.test(strVal)) return false;
            }
            return true;
          });
        };

        const timeoutNote = `\n\n⚠ Scan hit the ${timeout_ms}ms budget and returned PARTIAL results. Narrow the query (add edge_type, a more specific property_name), raise timeout_ms, or prefer an indexed tool. Browser heaps with millions of native/InternalNode nodes are slow to full-scan.`;

        if (output_mode === 'count') {
          let totalCount = 0;
          const nodeIds = new NumericSet();
          try {
            snapshot.nodes.forEach(node => {
              budget.tick();
              if (!isNodeWorthInspecting(node)) return;
              if (!matchesProperty(node)) return;
              totalCount++;
              nodeIds.add(node.id);
            });
          } catch (e) {
            if (e instanceof ScanTimeoutError) timedOut = true;
            else throw e;
          }
          // Dominator-aware aggregate: property-matching objects can nest on the
          // dominator tree, so a raw sum of retainedSize would double-count and
          // can exceed 100% of heap. On a timeout this reflects the partial set.
          const totalRetained = utils.aggregateDominatorMetrics(
            nodeIds,
            snapshot,
            () => true,
            (node: IHeapNode) => node.retainedSize,
          );
          return toolResult(
            `Objects with property ${filterDesc}: ${formatNumber(totalCount)}${timedOut ? '+' : ''} total, ${formatBytes(totalRetained)} aggregate retained size (dominator-deduplicated)` +
              (timedOut ? timeoutNote : ''),
          );
        }

        const results: IHeapNode[] = [];
        let totalCount = 0;

        try {
          snapshot.nodes.forEach(node => {
            budget.tick();
            if (!isNodeWorthInspecting(node)) return;
            if (!matchesProperty(node)) return;
            totalCount++;

            if (output_mode === 'ids') {
              results.push(node);
              return;
            }

            const size = node.retainedSize;
            let inserted = false;
            for (let i = 0; i < results.length; i++) {
              if (size > results[i].retainedSize) {
                results.splice(i, 0, node);
                inserted = true;
                break;
              }
            }
            if (!inserted) {
              results.push(node);
            }
            if (results.length > limit) {
              results.length = limit;
            }
          });
        } catch (e) {
          if (e instanceof ScanTimeoutError) timedOut = true;
          else throw e;
        }

        if (totalCount === 0) {
          return toolResult(`No objects found with property ${filterDesc}`);
        }

        if (output_mode === 'ids') {
          const sorted = results
            .sort((a, b) => b.retainedSize - a.retainedSize)
            .slice(0, limit);
          return toolResult(
            `Found ${formatNumber(totalCount)}${timedOut ? '+' : ''} objects with property ${filterDesc} (showing ${sorted.length} IDs)\n\nIDs: ${sorted.map(n => n.id).join(', ')}` +
              (timedOut ? timeoutNote : ''),
          );
        }

        const summaries = results.map(serializeNodeSummary);
        return toolResult(
          `Found ${formatNumber(totalCount)}${timedOut ? '+' : ''} objects with property ${filterDesc} (showing top ${summaries.length})\n\n${formatNodeSummaryTable(summaries)}` +
            (timedOut ? timeoutNote : ''),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
