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
import {extraNativeBytes} from '../heap-statistics.js';
import {getSnapshot, getSnapshotMetadata} from '../heap-state.js';
import {computeMemoryPartition, familyGroup} from '../heap-families.js';
import type {PartitionRow} from '../heap-families.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * "What is using the memory?" as one exclusive table.
 *
 * Dominator attribution cannot answer it: anything held by two owners — a
 * model in two collections, a cache entry also referenced by the UI — is
 * dominated by the root and credited to nobody. On one production web-app capture,
 * module attribution explained 12% of the heap and `largest_objects` was mostly
 * bundle strings, while the real owners (a per-message getter cache, the
 * interaction-tracing window) were invisible. This partition seeds framework
 * record families by SHAPE (works minified), resolves each node to the nearest
 * family on its dominator chain, and labels the remainder by the module or
 * global on its shortest retainer path.
 */
export function registerMemoryPartition(server: McpServer): void {
  server.tool(
    'memlab_memory_partition',
    'Answer "what is using the memory?" in ONE call: an exclusive partition of the heap where every byte lands in exactly one row. ' +
      'Seeds framework record families by their own property names, so it works on a minified build: React fibers / hooks / effects / update queues / elements, Backbone-style collections and listener records, interaction-tracing event records, module registry records and timing records, lazy-loader resource records, experiment config records, function-property memo caches (`fn.$$cache`), WebAssembly modules and SharedArrayBuffers, and the module registry. ' +
      'Each node is credited to the nearest family on its dominator chain; native DOM/Blink nodes go to DOM sub-families (style, layout, paint, fonts, images, DOM nodes); everything else is labelled by the module export or global on its SHORTEST retainer path, which still names shared caches that dominator tools credit to the root. ' +
      'Loaded code and bundle text are reported separately and excluded from the percentages. Pass `drill` with a family name to see which modules own that family.',
    {
      top: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(20)
        .describe('How many shortest-path owner rows to show (default 20).'),
      drill: z
        .string()
        .optional()
        .describe(
          'A family name (or substring), e.g. "fibers" or "telemetry": also list the shortest-path owners of the bytes in that family.',
        ),
      summary_only: z
        .boolean()
        .optional()
        .default(false)
        .describe('Group totals only (default false).'),
    },
    async ({top, drill, summary_only}) => {
      try {
        const snapshot = getSnapshot();
        const meta = getSnapshotMetadata();
        const p = computeMemoryPartition(snapshot, drill ?? null);
        const loaded = p.loadedCode.code + p.loadedCode.bundle;
        const app = p.total - loaded;
        const pct = (n: number): string =>
          app > 0 ? `${((n / app) * 100).toFixed(1)}%` : '—';

        const rows: Array<{group: string; name: string; row: PartitionRow}> =
          [];
        for (const [fam, row] of p.families) {
          rows.push({group: familyGroup(fam), name: fam, row});
        }
        for (const [d, row] of p.dom) {
          rows.push({group: 'DOM / Blink', name: d, row});
        }
        const owners = [...p.owners.entries()].sort(
          (a, b) => b[1].bytes - a[1].bytes,
        );

        const groupTotals = new Map<string, number>();
        for (const r of rows) {
          groupTotals.set(
            r.group,
            (groupTotals.get(r.group) ?? 0) + r.row.bytes,
          );
        }
        let ownerTotal = 0;
        for (const [, r] of owners) ownerTotal += r.bytes;
        groupTotals.set('Shortest-path owners', ownerTotal);

        const lines: string[] = [
          '## Memory partition',
          '',
          `**${formatBytes(app)}** partitioned (app memory) of ${formatBytes(p.total)} total` +
            (meta ? ` in \`${meta.fileName}\`` : '') +
            `; loaded code ${formatBytes(p.loadedCode.code)} and bundle text ${formatBytes(p.loadedCode.bundle)} excluded.` +
            (extraNativeBytes(snapshot) > 0
              ? ` ${formatBytes(extraNativeBytes(snapshot))} of native memory has no node (\`extra_native_bytes\`) and is in no group.`
              : ''),
          '',
          markdownTable(
            ['Group', 'Self bytes', '% of app'],
            [...groupTotals.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([g, b]) => [g, formatBytes(b), pct(b)]),
            new Set([1, 2]),
          ),
        ];

        if (!summary_only) {
          rows.sort((a, b) => b.row.bytes - a.row.bytes);
          lines.push(
            '',
            '### Families (nearest family on the dominator chain)',
            '',
            markdownTable(
              ['Group', 'Family', 'Self bytes', '% of app', 'Nodes'],
              rows.map(r => [
                r.group,
                r.name,
                formatBytes(r.row.bytes),
                pct(r.row.bytes),
                formatNumber(r.row.nodes),
              ]),
              new Set([2, 3, 4]),
            ),
            '',
            '### Everything else, by shortest-path owner',
            '',
            markdownTable(
              ['Owner', 'Self bytes', '% of app', 'Mostly'],
              owners.slice(0, top).map(([label, r]) => [
                label,
                formatBytes(r.bytes),
                pct(r.bytes),
                [...r.kinds.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 3)
                  .map(([k, v]) => `${k} ${formatBytes(v)}`)
                  .join(', '),
              ]),
              new Set([1, 2]),
            ),
          );
          if (owners.length > top) {
            let rest = 0;
            for (const [, r] of owners.slice(top)) rest += r.bytes;
            lines.push(
              '',
              `_${formatNumber(owners.length - top)} more owners hold ${formatBytes(rest)}._`,
            );
          }
        }

        if (p.drill != null) {
          const d = [...p.drill.entries()].sort((a, b) => b[1] - a[1]);
          lines.push(
            '',
            `### Drill: shortest-path owners of "${drill}"`,
            '',
            d.length === 0
              ? '_No family matched._'
              : markdownTable(
                  ['Owner', 'Self bytes'],
                  d.slice(0, top).map(([k, v]) => [k, formatBytes(v)]),
                  new Set([1]),
                ),
          );
        }

        lines.push(
          '',
          '_Exclusive: each node is counted once. A family row includes everything that family dominates; shared objects nobody dominates are labelled by the first module export or global on their shortest retainer path. `module:<Name>.<export>` names survive minification._',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
