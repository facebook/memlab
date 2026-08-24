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
import {artifactLabel} from '../artifact-classes.js';
import {computeHeapBudget, devFamilyBytes} from '../heap-budget.js';
import type {HeapBudget} from '../heap-budget.js';
import {
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
  withSnapshotAt,
} from '../snapshot-borrow.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  pathsHeader,
  toolResult,
} from '../utils.js';

/**
 * One call for "how much of this heap is not the app, and did the app itself
 * move?"
 *
 * The structural baseline currently requires composing three tools by hand —
 * `app_heap` for the bundle/code/app split, `dev_artifacts` for the React DEV /
 * Fast Refresh / console / a11y families, and `explain_delta --include-artifacts`
 * for JIT warmup, which `dev_artifacts` deliberately does not count. Skipping any
 * of the three produces a confident wrong answer rather than a gap: one measured
 * round showed +67 MB of aggregate growth that was ~85-90% React DEV tooling
 * with app memory flat, and the artifact share across a single sweep ranged from
 * 2.0% to 18.5%. Reported without the composition, that round is a leak.
 *
 * The `app_delta` is therefore the headline, not the total delta: it is the only
 * number in the report that a production build would also show.
 */

const DEV_FAMILY_LABEL: Record<string, string> = {
  console: 'DevTools console (CDP inspector)',
  a11y: 'a11y / CDP automation cache',
  devGlobal: 'dev/extension global',
  reactDebugStack: 'React DEV owner stack (_debugStack)',
  reactFastRefresh: 'React Fast Refresh registry ($RefreshSig$)',
  harness: 'automation/devtools bridge (test harness)',
};

function budgetRows(budget: HeapBudget): string[][] {
  const pct = (n: number): string =>
    budget.total > 0 ? `${((n / budget.total) * 100).toFixed(1)}%` : '—';
  return [
    ['App', formatBytes(budget.app), pct(budget.app)],
    ['Bundle / source text', formatBytes(budget.bundle), pct(budget.bundle)],
    ['Code / bytecode', formatBytes(budget.code), pct(budget.code)],
    [
      'Dev/automation-retained',
      formatBytes(budget.devOnly),
      pct(budget.devOnly),
    ],
    ['Known artifacts', formatBytes(budget.artifact), pct(budget.artifact)],
  ];
}

function signed(n: number): string {
  return `${n >= 0 ? '+' : '-'}${formatBytes(Math.abs(n))}`;
}

export function registerArtifactBudget(server: McpServer): void {
  server.tool(
    'memlab_artifact_budget',
    'ONE number for "how much of this heap is not the application", broken down by source — and, with a baseline, how much of the growth was the app rather than the tooling. ' +
      'Composes what otherwise takes three separate tools and a manual reconciliation: `memlab_app_heap` (bundle/code/app split), `memlab_dev_artifacts` (React DEV, Fast Refresh, CDP console, a11y) and the JIT-warmup family that `dev_artifacts` explicitly does NOT count.\n\n' +
      'Run it before quoting any growth number. Composing only two of the three produces a confident wrong answer, not a visible gap: one measured round showed +67 MB of aggregate growth that was ~85-90% React DEV tooling with app memory flat, and across a single sweep the artifact share ranged from 2.0% to 18.5%. ' +
      'With `baseline` set, **app_delta is the headline** — it is the only figure in the report that a production build would also show.',
    {
      target: z
        .string()
        .describe(
          'Snapshot to budget. Local path, manifold:// URL, or bare filename.',
        ),
      baseline: z
        .string()
        .optional()
        .describe(
          'Earlier rung. When given, every bucket is diffed and the APP delta is reported separately from the total — the difference between "the heap grew 67 MB" and "the app grew 4 MB".',
        ),
      max_file_size_mb: z
        .number()
        .optional()
        .describe('Per-file size ceiling, matching memlab_load_snapshot.'),
    },
    async ({target, baseline, max_file_size_mb}) => {
      try {
        const paths = baseline != null ? [baseline, target] : [target];
        const {rungs, largestMB} = resolveRungs(paths, max_file_size_mb);
        const targetRung = rungs[rungs.length - 1];
        const baseRung = baseline != null ? rungs[0] : null;
        // `computeHeapBudget` walks every node, so it is subject to the same
        // 90s scan guardrail as any other full-heap tool. Scale it from the
        // capture size rather than losing a large snapshot to the default.
        const scanBudgetMs = scaledTimeoutMs(largestMB);

        let baseBudget = null;
        if (baseRung != null) {
          armScanBudgetFor(scanBudgetMs);
          baseBudget = await withSnapshotAt(
            baseRung.localPath,
            computeHeapBudget,
          );
        }
        armScanBudgetFor(scanBudgetMs);
        const budget = await withSnapshotAt(
          targetRung.localPath,
          computeHeapBudget,
        );

        const nonApp = budget.total - budget.app;
        const nonAppPct = budget.total > 0 ? (nonApp / budget.total) * 100 : 0;

        const lines: string[] = [];
        lines.push('## Artifact budget');
        lines.push('');
        lines.push(
          `**${nonAppPct.toFixed(1)}% of \`${targetRung.label}\` is not the application** ` +
            `(${formatBytes(nonApp)} of ${formatBytes(budget.total)}); ` +
            `app-attributable is ${formatBytes(budget.app)} across ${formatNumber(budget.appNodes)} nodes.`,
        );
        lines.push('');

        if (baseBudget != null && baseRung != null) {
          const rows = [
            ['App', 'app', baseBudget.app, budget.app],
            [
              'Bundle / source text',
              'bundle',
              baseBudget.bundle,
              budget.bundle,
            ],
            ['Code / bytecode', 'code', baseBudget.code, budget.code],
            [
              'Dev/automation-retained',
              'devOnly',
              baseBudget.devOnly,
              budget.devOnly,
            ],
            [
              'Known artifacts',
              'artifact',
              baseBudget.artifact,
              budget.artifact,
            ],
            ['TOTAL', 'total', baseBudget.total, budget.total],
          ] as Array<[string, string, number, number]>;
          lines.push(
            markdownTable(
              ['Bucket', baseRung.label, targetRung.label, 'Δ'],
              rows.map(([label, , b, t]) => [
                label,
                formatBytes(b),
                formatBytes(t),
                signed(t - b),
              ]),
              new Set([1, 2, 3]),
            ),
          );
          lines.push('');
          const appDelta = budget.app - baseBudget.app;
          const totalDelta = budget.total - baseBudget.total;
          // A share only means anything when the two move the SAME way. On a
          // real Ads Manager ladder the total fell 46.8 MB while the app grew
          // 6.3 MB — JIT code being discarded masking real app growth — and
          // `appDelta/totalDelta` rendered that as "-14% of the -46.8 MB
          // total", which reads like the app shrank. That inversion is the
          // exact misreading this tool exists to prevent, so name it instead.
          const sameDirection =
            (appDelta >= 0 && totalDelta > 0) ||
            (appDelta <= 0 && totalDelta < 0);
          const share =
            totalDelta !== 0 && sameDirection
              ? ` — ${Math.abs((appDelta / totalDelta) * 100).toFixed(0)}% of the ${signed(totalDelta)} total`
              : '';
          lines.push(`**app_delta: ${signed(appDelta)}**${share}.`);
          if (totalDelta !== 0 && !sameDirection) {
            lines.push('');
            lines.push(
              `> ⚠️ **The app and the total moved in OPPOSITE directions**: the app ` +
                `${appDelta >= 0 ? 'GREW' : 'shrank'} ${formatBytes(Math.abs(appDelta))} while the total ` +
                `${totalDelta >= 0 ? 'grew' : 'fell'} ${formatBytes(Math.abs(totalDelta))}. Reading the total here ` +
                `would give exactly the wrong answer — quote **${signed(appDelta)}**.`,
            );
          }
          if (totalDelta > 0 && appDelta / totalDelta < 0.25) {
            lines.push('');
            lines.push(
              `> ⚠️ **Most of this growth is not the app.** Quoting ${signed(totalDelta)} as the leak ` +
                `would overstate it by ${formatBytes(totalDelta - appDelta)}. Report ${signed(appDelta)}.`,
            );
          }
        } else {
          lines.push(
            markdownTable(
              ['Bucket', 'Self size', '% of heap'],
              budgetRows(budget),
              new Set([1, 2]),
            ),
          );
        }
        lines.push('');

        const devFamilies = devFamilyBytes(budget);
        lines.push('### Dev/automation, by family');
        lines.push('');
        if (devFamilies.length === 0) {
          lines.push(
            'No dev/automation roots found. On a dev build driven over CDP that is itself ' +
              'suspicious — it usually means the families this looks for are not present under ' +
              'the names it knows, not that the capture is clean. Cross-check `memlab_dev_artifacts`.',
          );
        } else {
          lines.push(
            markdownTable(
              ['Family', 'Nodes', 'Self size'],
              devFamilies.map(f => [
                DEV_FAMILY_LABEL[f.family] ?? f.family,
                formatNumber(f.nodes),
                formatBytes(f.selfBytes),
              ]),
              new Set([1, 2]),
            ),
          );
        }
        lines.push('');

        lines.push('### Known-artifact families');
        lines.push('');
        const kinds = [...budget.artifactByKind.entries()].sort(
          (a, b) => b[1] - a[1],
        );
        if (kinds.length === 0) {
          lines.push('None.');
        } else {
          lines.push(
            markdownTable(
              ['Family', 'Self size'],
              kinds.map(([kind, bytes]) => [
                artifactLabel(kind),
                formatBytes(bytes),
              ]),
              new Set([1]),
            ),
          );
          lines.push('');
          lines.push(
            '_JIT warmup (`Code`/`BytecodeArray`/`FeedbackVector`/…) is counted here and NOT by ' +
              '`memlab_dev_artifacts`. It climbs at every rung of any hunt that drives new interactions, ' +
              'because new code paths compile — which is why a warmup-heavy ladder reads as a linear leak._',
          );
        }

        lines.push('');
        lines.push(
          '_Buckets are mutually exclusive self sizes and sum to the total; each node lands in the most ' +
            'specific bucket explaining why it is not app memory. Retained sizes overlap and would not sum._',
        );

        return toolResult(
          lines.join('\n'),
          pathsHeader(rungs.map(r => r.label)),
        );
      } catch (e) {
        return errorResult(e instanceof Error ? e : new Error(String(e)));
      }
    },
  );
}
