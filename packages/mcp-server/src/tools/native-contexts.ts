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
import {z} from 'zod';
import {getSnapshot, getSnapshotByHandle} from '../heap-state.js';
import {
  SHARED,
  UNATTRIBUTED,
  nativeContextAttribution,
  resolveNativeContextFilter,
} from '../native-context.js';
import {
  clampLabel,
  clampLabelTo,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

export function registerNativeContexts(server: McpServer): void {
  server.tool(
    'memlab_native_contexts',
    'Split ONE snapshot by JavaScript realm: the page, each iframe, extension isolated worlds, detached windows, Node `vm` contexts. Lists every NativeContext with the bytes it owns alone, plus the bytes SHARED by several realms and the bytes no realm reaches (engine internals). ' +
      "Ownership starts from each object's map (object → map → meta-map → NativeContext) and spreads along strong edges. " +
      'Pass `breakdown` (a NativeContext id, "shared" or "unattributed") for the largest classes in that bucket. To filter any object query by realm, use `native_context` on `memlab_query_objects`. ' +
      'To compare SEPARATE page and worker snapshots instead, use `memlab_realm_summary`.',
    {
      handle: z
        .string()
        .optional()
        .describe('Snapshot to analyze (defaults to the active one).'),
      breakdown: z
        .union([z.number(), z.string()])
        .optional()
        .describe(
          'Show the largest classes owned by this NativeContext id, or by "shared" / "unattributed".',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(20)
        .describe('Rows in the realm list and in the breakdown (default 20).'),
    },
    async ({handle, breakdown, limit}) => {
      try {
        const snapshot =
          handle != null ? getSnapshotByHandle(handle) : getSnapshot();
        if (snapshot == null) {
          return errorResult(
            new Error(`Snapshot "${handle}" is not resident.`),
          );
        }
        const started = Date.now();
        const a = nativeContextAttribution(snapshot);
        const attributed = a.contexts.reduce((s, c) => s + c.attributedSize, 0);
        const total = attributed + a.sharedSize + a.unattributedSize;
        const pct = (n: number) =>
          total > 0 ? `${((100 * n) / total).toFixed(1)}%` : '—';

        const lines = [
          `**${formatNumber(a.contexts.length)} native contexts.** Owned by one realm: ${formatBytes(attributed)} (${pct(attributed)}); shared: ${formatBytes(a.sharedSize)} (${pct(a.sharedSize)}); unattributed: ${formatBytes(a.unattributedSize)} (${pct(a.unattributedSize)}) — self sizes, adding up to ${formatBytes(total)}. (${((Date.now() - started) / 1000).toFixed(1)} s)`,
          '',
        ];
        const rows = a.contexts.slice(0, limit).map((c, i) => [
          String(i + 1),
          `@${c.id}`,
          // A realm label (usually its URL), not a node name: the session
          // name width does not apply.
          clampLabelTo(c.label || '(no tag)', 80),
          c.detached ? 'yes' : '',
          formatBytes(c.attributedSize),
          pct(c.attributedSize),
          formatNumber(c.attributedCount),
          formatBytes(c.retainedSize),
        ]);
        rows.push(
          [
            '',
            '',
            '(shared by several realms)',
            '',
            formatBytes(a.sharedSize),
            pct(a.sharedSize),
            formatNumber(a.sharedCount),
            '',
          ],
          [
            '',
            '',
            '(no realm)',
            '',
            formatBytes(a.unattributedSize),
            pct(a.unattributedSize),
            formatNumber(a.unattributedCount),
            '',
          ],
        );
        lines.push(
          markdownTable(
            [
              '#',
              'NativeContext',
              'Realm',
              'Detached',
              'Owned',
              '%',
              'Objects',
              'Retained',
            ],
            rows,
            new Set([4, 5, 6, 7]),
          ),
        );
        if (a.contexts.length > limit) {
          lines.push(
            `… ${formatNumber(a.contexts.length - limit)} more native contexts.`,
          );
        }
        lines.push(
          '',
          '_"Owned" counts each object once, under the one realm that reaches it; "Retained" is the dominator size of the NativeContext object itself and can include shared objects._',
        );

        if (breakdown != null) {
          const target = resolveNativeContextFilter(snapshot, breakdown);
          if ('error' in target) return errorResult(new Error(target.error));
          const byClass = new Map<
            string,
            {type: string; name: string; count: number; size: number}
          >();
          snapshot.nodes.forEach((node: IHeapNode) => {
            if (a.owner[node.nodeIndex] !== target.owner) return;
            const key = `${node.type}::${node.name}`;
            let row = byClass.get(key);
            if (row == null) {
              row = {type: node.type, name: node.name, count: 0, size: 0};
              byClass.set(key, row);
            }
            row.count++;
            row.size += node.self_size;
          });
          const top = [...byClass.values()]
            .sort((x, y) => y.size - x.size || x.name.localeCompare(y.name))
            .slice(0, limit);
          const title =
            target.owner === SHARED
              ? 'shared objects'
              : target.owner === UNATTRIBUTED
                ? 'unattributed objects'
                : `NativeContext @${snapshot.nodes.get(target.owner)?.id}`;
          lines.push('', `**Largest classes in ${title}** (by self size):`, '');
          lines.push(
            markdownTable(
              ['Class', 'Type', 'Count', 'Self'],
              top.map(r => [
                clampLabel(r.name, 80),
                r.type,
                formatNumber(r.count),
                formatBytes(r.size),
              ]),
              new Set([2, 3]),
            ),
          );
        }
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
