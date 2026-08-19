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
import {z} from 'zod';
import {getSnapshot, getSnapshotMetadata} from '../heap-state.js';
import {
  boundedDominatorRetainedSize,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

const {NumericSet} = memlabCore;

function matchesShape(node: IHeapNode, shape: string[]): boolean {
  const want = new Set(shape);
  for (const e of node.references) {
    if (e.type !== 'property') continue;
    want.delete(String(e.name_or_index));
    if (want.size === 0) return true;
  }
  return false;
}

export function registerWhatIf(server: McpServer): void {
  server.tool(
    'memlab_what_if',
    'If this set of objects were freed, how many bytes would actually come back? Reports the dominator-deduped retained size of a population — the bytes that go away when it does, with nothing double-counted and nothing counted that is also reachable another way.\n\n' +
      'This is the number every fix decision needs and the one that is easiest to get wrong by hand. Summing per-object retained sizes double-counts every nested object; quoting the class total counts memory that other live code still holds; quoting a container\'s retained size includes internals that survive. `memlab_detached_dom` already reports it for detached subtrees as "Owner Frees" — this makes the same question askable about any set.\n\n' +
      'Specify the population by ids, class name, or property shape.',
    {
      node_ids: z
        .array(z.number())
        .optional()
        .describe(
          'Explicit node ids to free (from any tool that reports ids).',
        ),
      class_name: z
        .string()
        .optional()
        .describe('Free every instance of this class (exact name match).'),
      shape: z
        .array(z.string())
        .optional()
        .describe(
          'Free every object carrying ALL of these properties — the usable selector on a minified heap.',
        ),
      breakdown: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Also report what the freed bytes consist of, grouped by the class of the dominated nodes (default true). Answers "am I freeing the records, or the data they point at?".',
        ),
      limit: z
        .number()
        .optional()
        .default(12)
        .describe('Rows in the breakdown table (default 12).'),
    },
    async ({node_ids, class_name, shape, breakdown, limit}) => {
      try {
        const snapshot = getSnapshot();
        const selectors = [
          node_ids != null && node_ids.length > 0,
          class_name != null,
          shape != null && shape.length > 0,
        ].filter(Boolean).length;
        if (selectors === 0) {
          return errorResult(
            new Error(
              'Pass node_ids, class_name or shape to select what to free.',
            ),
          );
        }
        if (selectors > 1) {
          return errorResult(
            new Error(
              'Pass exactly one of node_ids / class_name / shape — combining them would make the reported population ambiguous.',
            ),
          );
        }

        const ids: number[] = [];
        if (node_ids != null && node_ids.length > 0) {
          for (const id of node_ids) {
            if (snapshot.getNodeById(id) != null) ids.push(id);
          }
          if (ids.length === 0) {
            return errorResult(
              new Error(
                'None of those ids exist in the active snapshot. Node ids are per-capture — check the handle with memlab_snapshots.',
              ),
            );
          }
        } else {
          snapshot.nodes.forEach(node => {
            if (node.id <= 3) return;
            if (class_name != null) {
              if (node.name !== class_name) return;
            } else if (shape != null && !matchesShape(node, shape)) {
              return;
            }
            ids.push(node.id);
          });
        }

        if (ids.length === 0) {
          return toolResult(
            `Nothing matched, so there is nothing to free. Check the class name with \`memlab_class_histogram\` or the shape with \`memlab_shape_histogram\`.`,
          );
        }

        const idSet = new NumericSet(ids);
        const {retained, exact} = boundedDominatorRetainedSize(idSet, snapshot);
        const meta = getSnapshotMetadata();
        const heapTotal = meta?.totalSize ?? 0;
        const share = heapTotal > 0 ? (retained / heapTotal) * 100 : 0;

        let selfTotal = 0;
        for (const id of ids) {
          selfTotal += snapshot.getNodeById(id)?.self_size ?? 0;
        }

        const label =
          class_name != null
            ? `class \`${class_name}\``
            : shape != null
              ? `shape \`{${shape.join(', ')}}\``
              : `${formatNumber(ids.length)} explicit id(s)`;

        const lines: string[] = [
          `## What if ${label} were freed?`,
          '',
          `**${formatBytes(retained)} would be reclaimed**${exact ? '' : ' (upper bound — the dominator walk hit its depth cap)'}` +
            `${heapTotal > 0 ? `, ${share.toFixed(1)}% of the ${formatBytes(heapTotal)} heap` : ''}.`,
          '',
          `- Population: ${formatNumber(ids.length)} object(s)`,
          `- Their own bytes (self size): ${formatBytes(selfTotal)}`,
          `- Everything they exclusively dominate: ${formatBytes(retained)}`,
          '',
          retained > selfTotal * 2
            ? `Most of the win is in what these objects HOLD, not in the objects themselves (${formatBytes(retained - selfTotal)} of the total). Freeing them is worth it only if nothing else references that payload — which is exactly what dominator-deduped means, so this figure already accounts for it.`
            : "Nearly all of the win is the objects' own bytes; they hold little exclusively.",
        ];

        if (breakdown) {
          // What the reclaimed bytes actually consist of. "Freeing 26 MB" reads
          // very differently once you know 90% of it is one payload class.
          const byClass = new Map<string, {count: number; bytes: number}>();
          const seen = new Set<number>();
          for (const id of ids) {
            const start = snapshot.getNodeById(id);
            if (start == null) continue;
            const stack: IHeapNode[] = [start];
            while (stack.length > 0) {
              const n = stack.pop() as IHeapNode;
              if (seen.has(n.id)) continue;
              seen.add(n.id);
              const key = `${n.name} (${n.type})`;
              const e = byClass.get(key) ?? {count: 0, bytes: 0};
              e.count++;
              e.bytes += n.self_size;
              byClass.set(key, e);
              for (const edge of n.references) {
                const child = edge.toNode;
                if (
                  child.id > 3 &&
                  !seen.has(child.id) &&
                  child.dominatorNode?.id === n.id
                ) {
                  stack.push(child);
                }
              }
            }
          }
          const rows = [...byClass.entries()]
            .sort((a, b) => b[1].bytes - a[1].bytes)
            .slice(0, limit)
            .map(([name, e]) => [
              name.length > 50 ? name.slice(0, 47) + '…' : name,
              formatNumber(e.count),
              formatBytes(e.bytes),
            ]);
          lines.push(
            '',
            '### What the reclaimed bytes are',
            '',
            markdownTable(
              ['Class', 'Nodes', 'Self size'],
              rows,
              new Set([1, 2]),
            ),
          );
        }

        lines.push(
          '',
          '_Counts only what this population EXCLUSIVELY dominates: anything also reachable from elsewhere stays and is not included. It does not model second-order effects — objects that become collectable because a freed one was the last referrer of something it did not dominate are not counted, so treat this as a floor._',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
