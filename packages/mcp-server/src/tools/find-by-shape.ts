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
  isNodeWorthInspecting,
  serializeNodeSummary,
  formatNodeSummaryTable,
  formatNumber,
  formatBytes,
  errorResult,
  toolResult,
} from '../utils.js';

export function registerFindByShape(server: McpServer): void {
  server.tool(
    'memlab_find_by_shape',
    'Find all objects that have a specific set of property names (multi-property intersection search). Unlike find_by_property which searches for a single property, this finds objects matching a "shape" — objects that have ALL of the specified properties. Useful for finding instances of a specific record type, data structure, or component when you know its property names but not its constructor.',
    {
      properties: z
        .array(z.string())
        .min(1)
        .describe(
          'Property names that must ALL be present on matching objects (e.g., ["callback", "context", "priority"])',
        ),
      exclude_properties: z
        .array(z.string())
        .optional()
        .describe(
          'Property names that must NOT be present. Use to distinguish between similar shapes.',
        ),
      class_name: z
        .string()
        .optional()
        .describe(
          'Optional constructor name filter to narrow results (e.g., "Object", "EventHandlerRefInternal")',
        ),
      output_mode: z
        .enum(['full', 'count', 'ids'])
        .optional()
        .default('full')
        .describe(
          'Output verbosity: "full" returns node summaries (default), "count" returns only count and aggregate size, "ids" returns node IDs',
        ),
      follow_property: z
        .string()
        .optional()
        .describe(
          "For each matched object, resolve this property edge and include the target's " +
            'name, type, and ID in the output. Enables "find objects with shape X and tell ' +
            'me the distribution of property Y" in a single call.',
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of results (default 20)'),
    },
    async ({
      properties,
      exclude_properties,
      class_name,
      output_mode,
      follow_property,
      limit,
    }) => {
      try {
        const snapshot = getSnapshot();
        const requiredSet = new Set(properties);
        const excludeSet = new Set(exclude_properties ?? []);

        const matchesShape = (node: IHeapNode): boolean => {
          if (!isNodeWorthInspecting(node)) return false;
          if (class_name && node.name !== class_name) return false;

          const foundProps = new Set<string>();
          for (const edge of node.references) {
            if (edge.type !== 'property' && edge.type !== 'element') continue;
            const name = String(edge.name_or_index);
            if (excludeSet.has(name)) return false;
            if (requiredSet.has(name)) foundProps.add(name);
          }
          return foundProps.size === requiredSet.size;
        };

        const shapeDesc =
          `{${properties.join(', ')}}` +
          (exclude_properties?.length
            ? ` without {${exclude_properties.join(', ')}}`
            : '') +
          (class_name ? ` (class: ${class_name})` : '');

        if (output_mode === 'count') {
          let totalCount = 0;
          let totalSelf = 0;
          const nodeIds = new NumericSet();
          snapshot.nodes.forEach(node => {
            if (!matchesShape(node)) return;
            totalCount++;
            totalSelf += node.self_size;
            nodeIds.add(node.id);
          });
          if (totalCount === 0) {
            return toolResult(`No objects found matching shape ${shapeDesc}`);
          }
          // Dominator-aware aggregate: shape-matching objects can nest on the
          // dominator tree, so a raw sum of retainedSize would double-count and
          // can exceed 100% of heap.
          const totalRetained = utils.aggregateDominatorMetrics(
            nodeIds,
            snapshot,
            () => true,
            (node: IHeapNode) => node.retainedSize,
          );
          return toolResult(
            `Objects matching shape ${shapeDesc}: ${formatNumber(totalCount)} total, ${formatBytes(totalSelf)} self size, ${formatBytes(totalRetained)} aggregate retained size (dominator-deduplicated)`,
          );
        }

        const results: IHeapNode[] = [];
        let totalCount = 0;

        snapshot.nodes.forEach(node => {
          if (!matchesShape(node)) return;
          totalCount++;

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

        if (totalCount === 0) {
          return toolResult(
            `No objects found matching shape ${shapeDesc}\n\n` +
              `**Tips:**\n` +
              `- Check property names with \`memlab_object_shape\` on a known instance\n` +
              `- Try fewer required properties to broaden the search\n` +
              `- Use \`memlab_find_by_property\` with a single distinctive property first`,
          );
        }

        if (output_mode === 'ids') {
          return toolResult(
            `Found ${formatNumber(totalCount)} objects matching shape ${shapeDesc} (showing ${results.length} IDs)\n\nIDs: ${results.map(n => n.id).join(', ')}`,
          );
        }

        const summaries = results.map(serializeNodeSummary);
        const countNote =
          totalCount > results.length
            ? ` (${formatNumber(totalCount)} total, showing top ${results.length})`
            : '';

        const outputLines = [
          `Found ${formatNumber(totalCount)} objects matching shape ${shapeDesc}${countNote}`,
          '',
          formatNodeSummaryTable(summaries),
        ];

        if (follow_property && results.length > 0) {
          const followDistribution = new Map<
            string,
            {count: number; exampleId: number}
          >();
          let missingCount = 0;

          for (const node of results) {
            let found = false;
            for (const edge of node.references) {
              if (String(edge.name_or_index) === follow_property) {
                const target = edge.toNode;
                const key = `${target.name} (${target.type})`;
                const existing = followDistribution.get(key);
                if (existing) {
                  existing.count++;
                } else {
                  followDistribution.set(key, {
                    count: 1,
                    exampleId: target.id,
                  });
                }
                found = true;
                break;
              }
            }
            if (!found) missingCount++;
          }

          const sorted = [...followDistribution.entries()].sort(
            (a, b) => b[1].count - a[1].count,
          );

          outputLines.push(
            '',
            `**Property \`${follow_property}\` distribution across ${results.length} matches:**`,
          );
          for (const [key, info] of sorted.slice(0, 15)) {
            outputLines.push(
              `  - ${formatNumber(info.count)}× ${key} (example: @${info.exampleId})`,
            );
          }
          if (sorted.length > 15) {
            outputLines.push(`  - … and ${sorted.length - 15} more types`);
          }
          if (missingCount > 0) {
            outputLines.push(
              `  - ${formatNumber(missingCount)} object(s) missing property \`${follow_property}\``,
            );
          }
        }

        return toolResult(outputLines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
