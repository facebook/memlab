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
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
} from '../snapshot-borrow.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  pathsHeader,
  toolResult,
} from '../utils.js';
import {linearFit, probeRung, type LinearFit} from './ladder-probe.js';
import {resolveLadderPaths} from './ladder.js';

export interface RunFit {
  label: string;
  values: number[];
  xs: number[];
  fit: LinearFit;
  delta: number;
  grows: boolean;
  reason: string;
}

export type ReplicationVerdict =
  'REPRODUCED' | 'REPRODUCED_UNSTABLE' | 'NOT_REPRODUCED' | 'INCONCLUSIVE';

/**
 * Does this one run show the effect at all?
 *
 * Deliberately three conditions, not one. A slope alone is satisfied by noise;
 * an r2 alone is satisfied by a dead-flat series (which fits a horizontal line
 * perfectly); and a delta alone is satisfied by a single GC-band step. The
 * effect has to be present, linear, and big enough to be worth a name.
 */
export function classifyRun(
  label: string,
  values: number[],
  xs: number[],
  minR2: number,
  minDelta: number,
): RunFit {
  const fit = linearFit(xs, values);
  const delta = values[values.length - 1] - values[0];
  let grows = true;
  let reason = 'grows, linear, and above the delta floor';
  if (delta < minDelta) {
    grows = false;
    reason = `net delta ${formatNumber(delta)} is below the floor of ${formatNumber(minDelta)}`;
  } else if (fit.slope <= 0) {
    grows = false;
    reason = `slope ${fit.slope.toFixed(3)} is not positive`;
  } else if (fit.r2 < minR2) {
    grows = false;
    reason = `r2 ${fit.r2.toFixed(4)} is below ${minR2} — not a linear accumulation`;
  }
  return {label, values, xs, fit, delta, grows, reason};
}

/**
 * The whole point of the tool: a finding is not a finding until a SECOND,
 * independently-driven run shows the same thing.
 *
 * A single run cannot distinguish an effect from a one-off, no matter how clean
 * it looks — and "how clean it looks" is not a weak signal that can be tightened
 * away. The finding that motivated this passed every gate the workstream had
 * (r2 = 1.0000, permanent across nine minutes of idle with forced GC, 97%
 * concentrated under one dominator, dominator-deduped sizing, an app-side
 * retainer path with no dev-root hop) and did not reproduce on any of the next
 * three runs. Replication is the only gate that would have caught it, and it is
 * entirely mechanical, which is why it belongs in a tool rather than a habit.
 */
export function adjudicate(
  runs: RunFit[],
  slopeRatioTolerance: number,
): {verdict: ReplicationVerdict; summary: string} {
  if (runs.length < 2) {
    return {
      verdict: 'INCONCLUSIVE',
      summary:
        'Replication needs at least 2 independently-driven runs. One run cannot distinguish an effect from a one-off.',
    };
  }
  const growing = runs.filter(r => r.grows);
  if (growing.length === 0) {
    return {
      verdict: 'NOT_REPRODUCED',
      summary: `No run shows the effect (${runs.length}/${runs.length} flat or shrinking). There is nothing here to attribute.`,
    };
  }
  if (growing.length < runs.length) {
    const absent = runs.filter(r => !r.grows);
    return {
      verdict: 'NOT_REPRODUCED',
      summary:
        `${growing.length} of ${runs.length} runs show the effect and ${absent.length} do not ` +
        `(${absent.map(r => `${r.label}: ${r.reason}`).join('; ')}). ` +
        'A finding that appears in some runs and not others is not yet a finding — it is an ' +
        'unexplained difference between the runs. Find what differs before attributing it.',
    };
  }
  const slopes = growing.map(r => r.fit.slope);
  const ratio = Math.max(...slopes) / Math.min(...slopes);
  if (ratio > slopeRatioTolerance) {
    return {
      verdict: 'REPRODUCED_UNSTABLE',
      summary:
        `Every run shows the effect, but the magnitude is unstable: slopes range ` +
        `${Math.min(...slopes).toFixed(3)} to ${Math.max(...slopes).toFixed(3)} per cycle ` +
        `(${ratio.toFixed(1)}x, over the ${slopeRatioTolerance}x tolerance). ` +
        'The effect is real; quote it as a range, and do not size a fix off one run.',
    };
  }
  return {
    verdict: 'REPRODUCED',
    summary:
      `All ${runs.length} runs show the effect with consistent magnitude ` +
      `(slopes ${Math.min(...slopes).toFixed(3)}–${Math.max(...slopes).toFixed(3)} per cycle, ` +
      `${ratio.toFixed(1)}x spread). This is the evidence a filing needs.`,
  };
}

const RunSchema = z.object({
  paths: z
    .array(z.string())
    .optional()
    .describe(
      'Ordered snapshot paths for this run, oldest first. Omit only if `series` is given.',
    ),
  series: z
    .array(z.number())
    .optional()
    .describe(
      'Pre-measured values per rung, when you already have the numbers (e.g. from an earlier `memlab_ladder_probe`, or from a round whose snapshots are gone). Skips loading entirely.',
    ),
  cycles_per_rung: z
    .array(z.number())
    .optional()
    .describe(
      'Cumulative cycle count at each rung. Needed to compare runs whose ladders are spaced differently — without it the fit is per RUNG, and two runs with different cycle spacing are not comparable.',
    ),
  label: z.string().optional().describe('Name for this run in the report.'),
});

export function registerReplicate(server: McpServer): void {
  server.tool(
    'memlab_replicate',
    'Ask whether a measured effect REPRODUCES across two or more independently-driven runs, and refuse to call it real until it does. ' +
      'This is the gate that separates a finding from a one-off, and it is the one gate that cannot be replaced by looking harder at a single run.\n\n' +
      'Give it the same numeric probe and the ladders from N separate runs (or the pre-measured `series` if the snapshots are gone). ' +
      'It fits each run independently and returns REPRODUCED / REPRODUCED_UNSTABLE / NOT_REPRODUCED / INCONCLUSIVE.\n\n' +
      'Why it exists: a detached-DOM finding once passed every other gate — r2 = 1.0000, permanent across 9 minutes of idle with forced GC, ' +
      '97% concentrated under a single dominator, dominator-deduped sizing, an app-side retainer path that `memlab_dev_artifacts` classified as production — ' +
      'and failed to reproduce on all three follow-up runs. Every one of those checks was passed by a one-off. ' +
      'Run this BEFORE writing a finding up, not after.',
    {
      runs: z
        .array(RunSchema)
        .min(1)
        .describe(
          'Two or more INDEPENDENTLY-DRIVEN runs. Two ladders from the same browser session are not two runs — they share whatever one-off state produced the effect.',
        ),
      code: z
        .string()
        .optional()
        .describe(
          'The numeric probe, identical for every run, exactly as in memlab_ladder_probe. Required unless every run supplies `series`.',
        ),
      label: z
        .string()
        .optional()
        .describe('Name for the measured population.'),
      min_r2: z
        .number()
        .optional()
        .default(0.9)
        .describe(
          'Minimum r2 for a run to count as showing a linear accumulation (default 0.9).',
        ),
      min_delta: z
        .number()
        .optional()
        .default(1)
        .describe(
          'Minimum net growth for a run to count as showing the effect at all (default 1). Raise it to ignore single-object noise.',
        ),
      slope_ratio_tolerance: z
        .number()
        .optional()
        .default(3)
        .describe(
          'How far the per-run slopes may differ and still count as consistent (default 3x). Beyond it the verdict is REPRODUCED_UNSTABLE — real, but do not size a fix off one run.',
        ),
      timeout_ms: z.number().optional().describe('Per-rung execution timeout.'),
      max_nodes: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(20000000)
        .describe('Per-rung node-visit budget for full-heap walks.'),
      max_file_size_mb: z
        .number()
        .optional()
        .describe('Per-file size ceiling, matching memlab_load_snapshot.'),
    },
    async ({
      runs,
      code,
      label,
      min_r2,
      min_delta,
      slope_ratio_tolerance,
      timeout_ms,
      max_nodes,
      max_file_size_mb,
    }) => {
      try {
        const fits: RunFit[] = [];
        const allLabels: string[] = [];

        for (let i = 0; i < runs.length; i++) {
          const run = runs[i];
          const runLabel = run.label ?? `run ${i + 1}`;
          let values: number[];

          if (run.series != null && run.series.length > 0) {
            values = run.series;
          } else {
            if (run.paths == null || run.paths.length === 0) {
              return errorResult(
                new Error(
                  `${runLabel}: give it either \`paths\` or a pre-measured \`series\`.`,
                ),
              );
            }
            if (code == null || code.trim() === '') {
              return errorResult(
                new Error(
                  'Pass `code` — the probe has to be IDENTICAL across runs, otherwise the comparison is between two different questions.',
                ),
              );
            }
            const {paths: resolved} = resolveLadderPaths(run.paths);
            const {rungs: locals, largestMB} = resolveRungs(
              resolved,
              max_file_size_mb,
            );
            allLabels.push(...locals.map(r => r.label));
            const effectiveTimeout = scaledTimeoutMs(largestMB, timeout_ms);
            const measured: number[] = [];
            for (const {localPath} of locals) {
              armScanBudgetFor(effectiveTimeout);
              const out = await probeRung(
                localPath,
                [{name: 'probe', code}],
                effectiveTimeout,
                max_nodes,
              );
              const o = out.get('probe');
              if (o?.value == null) {
                return errorResult(
                  new Error(
                    `${runLabel}: a rung produced no number (${o?.error ?? 'unknown'}). Every rung must yield a value, or the two runs are not comparable.`,
                  ),
                );
              }
              measured.push(o.value);
            }
            values = measured;
          }

          if (values.length < 2) {
            return errorResult(
              new Error(
                `${runLabel} has ${values.length} rung(s); a rate needs at least 2.`,
              ),
            );
          }
          const xs =
            run.cycles_per_rung != null &&
            run.cycles_per_rung.length === values.length
              ? run.cycles_per_rung
              : values.map((_, j) => j);
          fits.push(classifyRun(runLabel, values, xs, min_r2, min_delta));
        }

        const {verdict, summary} = adjudicate(fits, slope_ratio_tolerance);

        const lines: string[] = [
          `## Replication — ${label != null ? `\`${label}\`` : 'probe'}`,
          '',
          markdownTable(
            ['Run', 'Series', 'Net Δ', 'Slope', 'r2', 'Shows effect?'],
            fits.map(f => [
              f.label,
              f.values.map(v => formatNumber(v)).join(' → '),
              `${f.delta >= 0 ? '+' : ''}${formatNumber(f.delta)}`,
              f.fit.slope.toFixed(3),
              f.fit.r2.toFixed(4),
              f.grows ? 'yes' : `NO — ${f.reason}`,
            ]),
            new Set([2, 3, 4]),
          ),
          '',
          `**Verdict: ${verdict}**`,
          '',
          summary,
          '',
        ];

        if (verdict === 'REPRODUCED' || verdict === 'REPRODUCED_UNSTABLE') {
          lines.push(
            '_Replication establishes that the effect is real and repeatable. It does NOT establish the cause — ' +
              'trace a sample with `memlab_retainer_trace` and rule out dev-only retention with `memlab_dev_artifacts` before attributing it._',
          );
        } else if (verdict === 'NOT_REPRODUCED') {
          lines.push(
            '_Do not file this. If a previous round already reported it, the honest action is a retraction: ' +
              'a one-off that passed every other gate is exactly what this tool exists to catch, and leaving it ' +
              'on the record costs more than the round it took to find._',
          );
        } else {
          lines.push(
            '_Drive a second independent run and re-check. Two ladders from the same browser session do not count — ' +
              'they share whatever one-off state produced the effect._',
          );
        }

        return toolResult(
          lines.join('\n'),
          allLabels.length > 0 ? pathsHeader(allLabels) : null,
        );
      } catch (e) {
        return errorResult(e instanceof Error ? e : new Error(String(e)));
      }
    },
  );
}
