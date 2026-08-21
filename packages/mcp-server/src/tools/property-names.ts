/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * The heap's VOCABULARY: every distinct property name, with how many objects
 * carry it and which classes those are.
 *
 * There was no way to ask this. `memlab_find_by_property` and
 * `helpers.withProp` both require you to already know the name;
 * `memlab_property_distribution` reports the VALUES of one known property. So
 * the names of the collections that matter — `vcMutationLog`, `postBuffers`,
 * `tracedInteractions`, `visualChangeRecordList` — could only be learned by
 * reading retainer traces one at a time and noticing them.
 *
 * Grepping the vocabulary is a fast and genuinely different way in: a pattern
 * like `/log$|buffer|queue|cache|pending|trace/i` surfaces the app's own
 * accumulator names in one indexed pass, and each one is then a
 * `memlab_collection_trend` locator or a `helpers.withProp` lookup away from a
 * measurement.
 */
export function registerPropertyNames(server: McpServer): void {
  server.tool(
    'memlab_property_names',
    "Index the heap's VOCABULARY: every distinct property name, how many objects carry it, and the classes that do. " +
      'Nothing else answers "what property names exist here?" — memlab_find_by_property and helpers.withProp need the name up front, and memlab_property_distribution reports the VALUES of a name you already have. ' +
      'This is the way to DISCOVER an app\'s accumulators instead of stumbling on them in a retainer trace: a pattern like "log$|buffer|queue|cache|pending|trace" surfaces their names in one pass, and each result is then a memlab_collection_trend locator or a helpers.withProp lookup away from being measured. ' +
      'Also useful in reverse — a name you expected and do NOT find is evidence the code path never ran.',
    {
      pattern: z
        .string()
        .optional()
        .describe(
          'Case-insensitive regex (or plain substring) to filter property names. Omit to list the most common names.',
        ),
      min_count: z
        .number()
        .optional()
        .default(2)
        .describe(
          'Ignore names carried by fewer objects than this (default 2).',
        ),
      limit: z
        .number()
        .optional()
        .default(40)
        .describe('Maximum names to report (default 40).'),
      sort_by: z
        .enum(['count', 'name'])
        .optional()
        .default('count')
        .describe('Sort by carrier count (default) or alphabetically.'),
    },
    async ({pattern, min_count, limit, sort_by}) => {
      try {
        const snapshot = getSnapshot();
        if (!snapshot) {
          return errorResult(
            'No heap snapshot loaded. Use memlab_load_snapshot first.',
          );
        }
        let re: RegExp | null = null;
        if (pattern != null && pattern.length > 0) {
          try {
            re = new RegExp(pattern, 'i');
          } catch {
            re = new RegExp(
              pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
              'i',
            );
          }
        }
        const counts = new Map<string, number>();
        const classes = new Map<string, Map<string, number>>();
        snapshot.nodes.forEach((node: IHeapNode) => {
          if (node.id <= 3) return;
          if (node.type !== 'object') return;
          for (const edge of node.references) {
            if (edge.type !== 'property') continue;
            const name = String(edge.name_or_index);
            if (name === '__proto__' || name === '') continue;
            if (re != null && !re.test(name)) continue;
            counts.set(name, (counts.get(name) ?? 0) + 1);
            let c = classes.get(name);
            if (!c) {
              c = new Map();
              classes.set(name, c);
            }
            c.set(node.name, (c.get(node.name) ?? 0) + 1);
          }
        });

        const rows = [...counts.entries()].filter(([, c]) => c >= min_count);
        rows.sort(
          sort_by === 'name'
            ? (a, b) => a[0].localeCompare(b[0])
            : (a, b) => b[1] - a[1],
        );
        const lines: string[] = [
          '## Property-name index',
          '',
          `${formatNumber(rows.length)} distinct property name(s)` +
            (re != null ? ` matching \`${pattern}\`` : '') +
            ` carried by at least ${formatNumber(min_count)} object(s).`,
          '',
        ];
        if (rows.length === 0) {
          lines.push(
            re != null
              ? `_No property name matches \`${pattern}\`. If you expected one, that is itself evidence — either the code path never ran in this capture, or the field is minified._`
              : '_No property names found._',
          );
          return toolResult(lines.join('\n'));
        }
        lines.push(
          markdownTable(
            ['Property', 'Objects', 'Top carrier classes'],
            rows.slice(0, limit).map(([name, count]) => {
              const cls = [...(classes.get(name) ?? new Map()).entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([c, n]) => `${c} (${formatNumber(n)})`)
                .join(', ');
              return [
                name.length > 44 ? name.slice(0, 41) + '…' : name,
                formatNumber(count),
                cls.length > 70 ? cls.slice(0, 67) + '…' : cls,
              ];
            }),
            new Set([1]),
          ),
        );
        lines.push(
          '',
          '**Next:** `memlab_collection_trend({locators: ["<CarrierClass>.<property>"]})` to see whether it grows across a ladder, `memlab_find_by_property` to list the carriers, or `memlab_property_distribution` for the value cardinality of one name.',
        );
        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(
          `Failed to index property names: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
