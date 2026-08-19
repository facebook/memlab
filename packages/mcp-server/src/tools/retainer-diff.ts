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
import {
  getCurrentHandle,
  getMetadataByHandle,
  getSnapshotByHandle,
  listSnapshots,
} from '../heap-state.js';
import {
  clusterByRetainerPath,
  renderClusterChain,
  selectPopulation,
} from './trace-all.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

interface DiffRow {
  key: string;
  before: number;
  after: number;
  delta: number;
  chain: string;
  exampleAfter: number | null;
}

export function registerRetainerDiff(server: McpServer): void {
  server.tool(
    'memlab_retainer_diff',
    'A population grew between two snapshots — did it grow along the SAME retention path, or did a new one appear?\n\n' +
      'This is the question a count diff cannot answer and the one that decides what to fix. "42,000 → 61,000 listener records" is consistent with two completely different bugs: an existing owner accumulating faster, or a second owner that did not exist before. A count, a class histogram and a population diff all read identically in the two cases.\n\n' +
      'Clusters the full population by retainer path in BOTH snapshots and reports paths that are new, grew, shrank or vanished. Both snapshots must be resident (load with `keep_previous: true`); the active snapshot is not changed.',
    {
      before_handle: z
        .string()
        .describe(
          'Handle of the earlier snapshot (memlab_snapshots lists them).',
        ),
      after_handle: z.string().describe('Handle of the later snapshot.'),
      class_name: z
        .string()
        .optional()
        .describe('Population: every instance of this class.'),
      shape: z
        .array(z.string())
        .optional()
        .describe(
          'Population: every object carrying ALL of these properties — the selector that survives minification, and the one to use here since node ids and class names are not comparable across captures.',
        ),
      framework_filter: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Collapse V8/framework internals out of the path signature so structurally identical application paths compare equal (default true).',
        ),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe('Rows in the change table (default 10).'),
      max_depth: z
        .number()
        .optional()
        .describe(
          'Compare on the first N hops from the GC ROOT instead of the whole path. Defaults to the whole path; use 5-7 when the full-depth signature fragments into roughly one path per object (a per-chat property edge or a per-event listener array does that), which otherwise makes every path look new or vanished.',
        ),
      max_trace: z
        .number()
        .optional()
        .default(200000)
        .describe('Per-snapshot bound on nodes traced (default 200,000).'),
    },
    async ({
      before_handle,
      after_handle,
      class_name,
      shape,
      framework_filter,
      limit,
      max_depth,
      max_trace,
    }) => {
      try {
        if ((class_name == null) === (shape == null || shape.length === 0)) {
          return errorResult(
            new Error(
              'Pass exactly one of class_name / shape. Node ids are per-capture and cannot select a population in two snapshots, which is why node_ids is not accepted here.',
            ),
          );
        }
        const resolve = (h: string) => {
          const snap = getSnapshotByHandle(h);
          const meta = getMetadataByHandle(h);
          if (snap == null || meta == null) {
            const available = listSnapshots()
              .map(m => m.handle)
              .join(', ');
            throw new Error(
              `No resident snapshot with handle "${h}". Resident: ${available === '' ? '(none)' : available}. Load both rungs with memlab_load_snapshot({keep_previous: true}).`,
            );
          }
          if (meta.light) {
            throw new Error(
              `Snapshot "${h}" was loaded with light: true, which skips the path/dominator pass — there are no retainer paths to compare. Reload it with light: false.`,
            );
          }
          return {snap, meta};
        };
        const before = resolve(before_handle);
        const after = resolve(after_handle);
        if (before_handle === after_handle) {
          return errorResult(
            new Error('before_handle and after_handle are the same snapshot.'),
          );
        }

        const sel = {className: class_name, shape};
        const b = clusterByRetainerPath(
          selectPopulation(before.snap, sel),
          framework_filter,
          max_trace,
          max_depth,
        );
        const a = clusterByRetainerPath(
          selectPopulation(after.snap, sel),
          framework_filter,
          max_trace,
          max_depth,
        );
        if (b.clusters.length === 0 && a.clusters.length === 0) {
          return toolResult(
            'The population is empty (or unreachable) in both snapshots — nothing to compare. Check the selector with `memlab_class_histogram` / `memlab_shape_histogram` on each handle.',
          );
        }

        const beforeByKey = new Map(b.clusters.map(c => [c.key, c]));
        const afterByKey = new Map(a.clusters.map(c => [c.key, c]));
        const rows: DiffRow[] = [];
        for (const key of new Set([
          ...beforeByKey.keys(),
          ...afterByKey.keys(),
        ])) {
          const bc = beforeByKey.get(key);
          const ac = afterByKey.get(key);
          const representative = ac ?? bc;
          if (representative == null) continue;
          const beforeCount = bc?.count ?? 0;
          const afterCount = ac?.count ?? 0;
          if (beforeCount === afterCount) continue;
          rows.push({
            key,
            before: beforeCount,
            after: afterCount,
            delta: afterCount - beforeCount,
            chain: renderClusterChain(representative.steps),
            exampleAfter: ac?.exampleIds[0] ?? null,
          });
        }
        rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

        const bTotal = b.traced;
        const aTotal = a.traced;
        const label =
          class_name != null
            ? `class \`${class_name}\``
            : `shape \`{${(shape ?? []).join(', ')}}\``;

        const lines: string[] = [
          `## Retention paths for ${label}: ${before.meta.fileName} → ${after.meta.fileName}`,
          '',
          `Population: **${formatNumber(bTotal)} → ${formatNumber(aTotal)}** traced objects (${aTotal - bTotal >= 0 ? '+' : ''}${formatNumber(aTotal - bTotal)}), across **${formatNumber(b.clusters.length)} → ${formatNumber(a.clusters.length)}** distinct paths.`,
        ];
        if (b.truncated || a.truncated) {
          lines.push(
            '',
            `⚠ The ${formatNumber(max_trace)}-node trace bound was hit in ${b.truncated && a.truncated ? 'both snapshots' : b.truncated ? 'the BEFORE snapshot' : 'the AFTER snapshot'}, so the counts below are of a partial sweep and the two sides may not be comparable. Raise \`max_trace\`.`,
          );
        }

        if (
          max_depth == null &&
          Math.max(b.clusters.length, a.clusters.length) >
            Math.max(bTotal, aTotal) * 0.5
        ) {
          lines.push(
            '',
            `⚠ ${formatNumber(a.clusters.length)} paths for ${formatNumber(aTotal)} objects — the full-depth signature is keying on a per-instance hop, so paths do not line up across captures and almost everything below will read as new or vanished. Re-run with \`max_depth: 5\` (or 6-7) to compare owners rather than instances.`,
          );
        }

        if (rows.length === 0) {
          lines.push(
            '',
            '**Every path holds exactly the same count in both snapshots.** The population did not change along any retention path — if a total did change, it changed somewhere this selector does not cover.',
          );
          return toolResult(lines.join('\n'));
        }

        const newPaths = rows.filter(r => r.before === 0);
        const grown = rows.filter(r => r.before > 0 && r.delta > 0);
        const gone = rows.filter(r => r.after === 0);

        lines.push(
          '',
          newPaths.length > 0
            ? `**${formatNumber(newPaths.length)} path(s) are NEW**, holding ${formatNumber(newPaths.reduce((s, r) => s + r.after, 0))} object(s) that had no counterpart in the earlier snapshot. A new path is a different bug from an existing one accumulating: the owner did not exist before, so a fix aimed at the pre-existing owner will not touch it.`
            : `**No new paths.** All of the change is existing owners holding more or fewer objects, so the retention MECHANISM is unchanged and the question is what is driving the rate.`,
        );
        if (grown.length > 0 && newPaths.length > 0) {
          lines.push(
            '',
            `${formatNumber(grown.length)} pre-existing path(s) also grew, by ${formatNumber(grown.reduce((s, r) => s + r.delta, 0))} object(s) in total — both mechanisms are active, so sizing a fix against either one alone will over-promise.`,
          );
        }

        lines.push(
          '',
          markdownTable(
            ['Change', 'Before', 'After', 'Δ', 'Example'],
            rows
              .slice(0, limit)
              .map(r => [
                r.before === 0
                  ? 'NEW'
                  : r.after === 0
                    ? 'gone'
                    : r.delta > 0
                      ? 'grew'
                      : 'shrank',
                formatNumber(r.before),
                formatNumber(r.after),
                `${r.delta >= 0 ? '+' : ''}${formatNumber(r.delta)}`,
                r.exampleAfter != null ? `@${r.exampleAfter}` : '—',
              ]),
            new Set([1, 2, 3]),
          ),
        );
        if (rows.length > limit) {
          lines.push(
            '',
            `_${formatNumber(rows.length - limit)} further changed path(s) not shown; raise \`limit\`._`,
          );
        }

        rows.slice(0, Math.min(limit, 5)).forEach((r, i) => {
          lines.push(
            '',
            `### ${i + 1}. ${r.before === 0 ? 'NEW' : r.after === 0 ? 'gone' : r.delta > 0 ? 'grew' : 'shrank'} ${formatNumber(r.before)} → ${formatNumber(r.after)}`,
            '',
            r.chain,
          );
        });

        if (gone.length > 0) {
          lines.push(
            '',
            `_${formatNumber(gone.length)} path(s) present before and absent after (${formatNumber(gone.reduce((s, x) => s + x.before, 0))} objects). That is usually a genuine release, but it is also what a differently-shaped path looks like after a code change renamed something in it — the signature includes class names._`,
          );
        }

        lines.push(
          '',
          '_Paths are matched by structural signature, so a rename anywhere along a chain reads as one path vanishing and another appearing. Bytes are not compared here — use `memlab_what_if` on a cluster for what a fix at one owner would free._',
          '',
          `Active snapshot unchanged (${getCurrentHandle() ?? 'none'}).`,
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
