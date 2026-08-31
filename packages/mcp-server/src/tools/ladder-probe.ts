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
  withSnapshotAt,
} from '../snapshot-borrow.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  pathsHeader,
  toolResult,
} from '../utils.js';
import {runEval} from './eval.js';
import {resolveLadderPaths} from './ladder.js';

/** The tool result shape the MCP SDK expects; runEval returns exactly this. */
type TextResult = {content: Array<{type: 'text'; text: string}>};

function textOf(result: unknown): string {
  const content = (result as TextResult)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map(c => (typeof c?.text === 'string' ? c.text : ''))
    .join('\n')
    .trim();
}

/**
 * Pull a single number out of whatever the probe returned.
 *
 * `memlab_eval` renders `result` as text, so the value has to be recovered
 * rather than read. A bare number is the documented contract; a one-key object
 * (`{count: 42}`) is accepted because that is what people write by reflex.
 *
 * Anything else is REFUSED rather than guessed. An earlier version fell back to
 * "take the last number in the output", which turned `result = {a: 1, b: 2}`
 * into the value 2 — a plausible series built from the wrong field. A probe
 * that silently measures something other than what was asked is worse than one
 * that errors, because the rate it produces looks exactly as trustworthy as a
 * real one.
 */
export function extractNumber(text: string): number | null {
  // `memlab_eval` wraps the value: a "> Snapshot: ..." session header above it
  // and a "--- ..." footer below carrying `nodes_visited`, truncation notes,
  // save confirmations and built-in-tool hints. Both have to come off before
  // the value can be read.
  //
  // The footer is not cosmetic to get wrong. A probe whose code happens to
  // trigger a hint — say a `{callback, context}` census, which is one of the
  // populations this tool exists to measure — otherwise produces
  // `"1125\n\n--- note: ..."`, which parses as neither a number nor JSON, so
  // EVERY rung reports "probe did not yield a number" and the measurement is
  // lost. Found by running a real ladder, not by reading the code.
  const lines = text.split('\n');
  const footerAt = lines.findIndex(line => line.startsWith('--- '));
  const body = footerAt >= 0 ? lines.slice(0, footerAt) : lines;
  const trimmed = body
    .filter(line => !line.startsWith('> '))
    .join('\n')
    .trim();
  if (trimmed === '') return null;
  const direct = Number(trimmed);
  if (Number.isFinite(direct)) return direct;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
    if (
      parsed != null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      const values = Object.values(parsed as Record<string, unknown>);
      if (
        values.length === 1 &&
        typeof values[0] === 'number' &&
        Number.isFinite(values[0])
      ) {
        return values[0];
      }
    }
  } catch {
    // Not JSON, and not a bare number: refuse.
  }
  return null;
}

export interface LinearFit {
  slope: number;
  intercept: number;
  r2: number;
}

/**
 * Least-squares fit of value against x.
 *
 * r-squared is the point. "Grew at every step" is a weak claim on four rungs —
 * it is one bit of information and any noisy upward drift satisfies it. A slope
 * with r2 ~= 1.0 says the population is a linear function of interaction count,
 * which is the actual shape of an unbounded per-cycle leak and is what
 * distinguishes it from a cache filling toward a plateau.
 *
 * A perfectly flat series has zero variance to explain; r2 is reported as 1
 * there because "the line explains the data" is true and the alternative (NaN,
 * from 0/0) reads as a failure when the answer is a clean negative.
 */
export function linearFit(xs: number[], ys: number[]): LinearFit {
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return {slope, intercept, r2};
}

export function verdictFor(
  values: number[],
  fit: LinearFit,
  axisAssumed = false,
): string {
  const n = values.length;
  const delta = values[n - 1] - values[0];
  // FLAT is the strongest negative claim this produces, so it has to mean the
  // whole series was flat — not merely that the two ENDS coincide. A series like
  // [10, 5, 15, 10] has delta 0 while swinging by 10 in between, and calling
  // that "identical at both ends" reads as "nothing happened" when something
  // clearly did. Check the full range before claiming it.
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return 'FLAT — identical at every rung';
  if (delta === 0) {
    return (
      `ends where it started (${formatNumber(values[0])}) but swung between ` +
      `${formatNumber(min)} and ${formatNumber(max)} in between — NOT flat; ` +
      'usually GC timing rather than a trend, but read the per-rung deltas above'
    );
  }
  if (delta < 0) return 'shrank';
  // "grew every step" must mean STRICTLY increasing. Accepting non-decreasing
  // let a step function claim steady growth: the series [924, 924, 1297, 1297]
  // was reported as "grew every step (but not a clean line)" when two of its
  // three steps were zero. That is the opposite diagnosis — one jump then a
  // plateau is bounded first-mount allocation, not an unbounded per-cycle leak —
  // and the wording sent a reader looking for a slope that is not there.
  let nonDecreasing = true;
  let strictlyIncreasing = true;
  let risingSteps = 0;
  let flatSteps = 0;
  let firstJump = -1;
  for (let i = 1; i < n; i++) {
    if (values[i] < values[i - 1]) {
      nonDecreasing = false;
      strictlyIncreasing = false;
    } else if (values[i] === values[i - 1]) {
      strictlyIncreasing = false;
      flatSteps++;
    } else {
      risingSteps++;
      if (firstJump < 0) firstJump = i;
    }
  }
  if (strictlyIncreasing && fit.r2 >= 0.98) {
    return 'LINEAR — grew every step, r2 >= 0.98 (unbounded per-cycle shape)';
  }
  if (strictlyIncreasing) {
    // r2 is invariant under an affine change of x, so when the cycle axis was
    // INFERRED as evenly spaced this number is really a fit against rung index.
    // A population that is exactly linear in cycles but sampled at uneven
    // cycle counts (0 / 2.5k / 5k / 10k, say) is then guaranteed to score below
    // 1.0 and gets reported as "not a clean line" — a property of the assumed
    // axis, not of the data. Nothing in the series can distinguish the two, so
    // say so rather than asserting non-linearity the tool cannot see.
    return axisAssumed
      ? 'grew every step; r2 < 0.98 against an ASSUMED evenly-spaced axis — ' +
          'if the rungs were NOT evenly spaced in cycles, pass cycles_per_rung ' +
          'and re-read the fit before concluding the growth is non-linear'
      : 'grew every step (but not a clean line)';
  }
  // Non-decreasing with at least one flat step. Name the shape instead of
  // rounding it up to growth; a single jump is the classic bounded allocation.
  if (nonDecreasing) {
    if (risingSteps === 1) {
      return (
        `STEP FUNCTION — flat except for ONE jump at rung ${firstJump} ` +
        `(${formatNumber(values[firstJump - 1])} → ${formatNumber(values[firstJump])}), ` +
        'flat on the other ' +
        `${flatSteps} step(s). NOT a per-cycle slope — this is the shape of a ` +
        'bounded one-time allocation (e.g. first mount of a surface), so size ' +
        'what it actually retains before treating it as a leak'
      );
    }
    return (
      `non-decreasing but NOT strictly increasing — ${risingSteps} rising step(s) ` +
      `and ${flatSteps} flat step(s); read the per-rung deltas above rather than ` +
      'the trend line, since flat steps mean growth is episodic, not per-cycle'
    );
  }
  return 'grew net, not monotonic — often GC/navigation noise';
}

interface Rung {
  label: string;
  localPath: string;
  value: number | null;
  error: string | null;
}

type ProbeOutcome = {value: number | null; error: string | null};

/**
 * Run EVERY metric against one rung, inside a single load of that rung.
 *
 * The load is what costs: a 300 MB capture takes far longer to parse and build
 * dominators for than any probe takes to run against it. Measured usage of this
 * tool is a dozen calls over the same ladder, each asking a one-line question —
 * `helpers.byClass(X).length` — and each re-loading every rung. Batching the
 * metrics collapses that to one pass over the ladder.
 */
export async function probeRung(
  localPath: string,
  metrics: Array<{name: string; code: string}>,
  timeoutMs: number,
  maxNodes: number,
): Promise<Map<string, ProbeOutcome>> {
  const out = new Map<string, ProbeOutcome>();
  try {
    await withSnapshotAt(localPath, async () => {
      for (const metric of metrics) {
        try {
          const res = await runEval({
            mode: 'eval',
            code: metric.code,
            timeout_ms: timeoutMs,
            max_nodes: maxNodes,
          });
          const text = textOf(res);
          const value = extractNumber(text);
          out.set(
            metric.name,
            value == null
              ? {
                  value: null,
                  error: `probe did not yield a number (got: ${text.slice(0, 120) || 'empty'})`,
                }
              : {value, error: null},
          );
        } catch (e) {
          // One metric failing must not cost the others their rung: the whole
          // point of batching is that they share an expensive load.
          out.set(metric.name, {
            value: null,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    for (const metric of metrics) {
      if (!out.has(metric.name)) out.set(metric.name, {value: null, error});
    }
  }
  return out;
}

export function registerLadderProbe(server: McpServer): void {
  server.tool(
    'memlab_ladder_probe',
    'Run ONE numeric probe across an ORDERED ladder of snapshots and report the series, the per-cycle rate and a linear fit. ' +
      'This is the "what is the rate of X?" tool, where X is any population YOU can express — not one of the built-in class histograms.\n\n' +
      '`memlab_leak_report` and `memlab_sequence_analysis` answer this for CLASSES. Every other question — how many ' +
      '`{callback, context}` listener records are held per event, how many entries a named cache holds, how many update ' +
      'records match a shape, how large a specific registry has grown — has to be written as an eval, and answering it ' +
      'across a six-rung ladder by hand costs a load + eval + save + unload per rung and a manual diff at the end. ' +
      'That friction is enough that the question often just does not get asked, so the round reports a class-level verdict ' +
      'and the actual finding goes unmeasured.\n\n' +
      'Differs from `memlab_eval_across`, which requires every snapshot to be RESIDENT simultaneously — impossible for a ' +
      'ladder of large captures. This resolves PATHS, reuses any rung that happens to be resident, and otherwise loads ' +
      'and drops one graph at a time, restoring your active snapshot when it finishes.\n\n' +
      'Report `r2` alongside the slope: "grew at every step" is one bit and any noisy drift satisfies it, whereas a slope ' +
      'with r2 near 1.0 is the signature of an unbounded per-cycle leak and is what separates it from a cache filling ' +
      'toward a plateau.',
    {
      paths: z
        .array(z.string())
        .min(1)
        .describe(
          'Ordered snapshot paths, oldest rung first. Local paths, manifold:// URLs, bare filenames, or a single ["ladder:<name>"] reference.',
        ),
      code: z
        .string()
        .optional()
        .describe(
          'JavaScript run against each rung, exactly as in memlab_eval, which must assign a NUMBER to `result` — e.g. `result = helpers.byClass("OpusRecorder").length`. A one-key object such as {count: n} is also accepted. Provide this OR `metrics`.',
        ),
      metrics: z
        .record(z.string())
        .optional()
        .describe(
          'SEVERAL named probes measured in ONE pass over the ladder: {"detached_rows": "result = …", "listener_records": "result = …"}. Strongly preferred over calling this tool once per question — the snapshot LOAD dominates the cost, so N metrics in one call costs roughly the same as one, where N separate calls costs N times as much. Each value follows the same rules as `code`; one metric failing does not cost the others their rung.',
        ),
      cycles: z
        .number()
        .optional()
        .describe(
          'Interaction cycles driven between the FIRST and LAST rung. When given, the rate is reported per cycle (the number a leak is actually quoted in) and the fit is against cycle count rather than rung index. Rungs are assumed evenly spaced in cycles unless cycles_per_rung is given.',
        ),
      cycles_per_rung: z
        .array(z.number())
        .optional()
        .describe(
          'Exact cumulative cycle count at each rung, when the ladder is NOT evenly spaced (the common case — rungs are placed on a schedule, not at equal intervals). Must match `paths` in length; overrides `cycles`.',
        ),
      label: z
        .string()
        .optional()
        .describe('Name for the probed population, used in the report header.'),
      timeout_ms: z
        .number()
        .optional()
        .describe(
          'Per-rung execution timeout. Defaults to a value scaled from the largest rung (a full-heap walk on a multi-million-node graph does not finish in the 60 s eval default).',
        ),
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
      paths,
      code,
      metrics,
      cycles,
      cycles_per_rung,
      label,
      timeout_ms,
      max_nodes,
      max_file_size_mb,
    }) => {
      try {
        const {paths: resolved} = resolveLadderPaths(paths);
        if (resolved.length < 2) {
          return errorResult(
            new Error(
              `memlab_ladder_probe needs at least 2 rungs; got ${resolved.length}. A rate needs two points.`,
            ),
          );
        }
        if (
          cycles_per_rung != null &&
          cycles_per_rung.length !== resolved.length
        ) {
          return errorResult(
            new Error(
              `cycles_per_rung has ${cycles_per_rung.length} entries but the ladder has ${resolved.length} rungs.`,
            ),
          );
        }

        // `code` and `metrics` are the same feature at different arities; one
        // pass over the ladder answers either.
        const metricList: Array<{name: string; code: string}> = [];
        if (code != null && code.trim() !== '') {
          metricList.push({name: label ?? 'probe', code});
        }
        for (const [name, mCode] of Object.entries(metrics ?? {})) {
          metricList.push({name, code: mCode});
        }
        if (metricList.length === 0) {
          return errorResult(
            new Error(
              'Pass `code` for a single probe, or `metrics` for several measured in one pass over the ladder.',
            ),
          );
        }

        const {rungs: locals, largestMB} = resolveRungs(
          resolved,
          max_file_size_mb,
        );
        const effectiveTimeout = scaledTimeoutMs(largestMB, timeout_ms);

        // Parallel to metricList by INDEX rather than keyed by name: a name is
        // not guaranteed unique (a `label` can collide with a `metrics` key),
        // and a keyed map would silently merge two series into one.
        const perMetric: Rung[][] = metricList.map(() => []);
        for (const {label: rungLabel, localPath} of locals) {
          // Per rung, not once: the budget is a wall clock, so a six-rung
          // ladder would otherwise spend rung 1's allowance and starve rung 6.
          armScanBudgetFor(effectiveTimeout);
          const outcomes = await probeRung(
            localPath,
            metricList,
            effectiveTimeout,
            max_nodes,
          );
          metricList.forEach((m, mi) => {
            const o = outcomes.get(m.name) ?? {
              value: null,
              error: 'metric not measured',
            };
            perMetric[mi].push({
              label: rungLabel,
              localPath,
              value: o.value,
              error: o.error,
            });
          });
        }

        const xsFor = (n: number): number[] =>
          Array.from({length: n}, (_, i) => {
            if (cycles_per_rung != null) return cycles_per_rung[i];
            if (cycles != null) return (cycles * i) / (n - 1);
            return i;
          });
        const perCycleKnown = cycles != null || cycles_per_rung != null;
        // `cycles` alone spreads the rungs evenly over the range. That is a
        // guess about how the ladder was driven, and it silently becomes the
        // x-axis every fit is scored against.
        const axisAssumed = cycles != null && cycles_per_rung == null;

        const lines: string[] = [];
        const multi = metricList.length > 1;
        lines.push(
          multi
            ? `## Ladder probe — ${metricList.length} metrics over ${locals.length} rungs`
            : `## Ladder probe — \`${metricList[0].name}\``,
        );
        lines.push('');
        if (multi) {
          lines.push(
            `_All ${metricList.length} metrics were measured in a single pass over the ladder — each rung was loaded once._`,
          );
          lines.push('');
        }

        let anyUsable = false;
        for (let mi = 0; mi < metricList.length; mi++) {
          const m = metricList[mi];
          const rungs = perMetric[mi];
          const xs = xsFor(rungs.length);
          const usable = rungs.filter(
            (r): r is Rung & {value: number} => r.value != null,
          );
          if (multi) {
            lines.push(`### \`${m.name}\``);
            lines.push('');
          }
          if (usable.length < 2) {
            const errs = rungs
              .filter(r => r.error != null)
              .map(r => `- ${r.label}: ${r.error}`)
              .join('\n');
            lines.push(
              `**UNMEASURED** — only ${usable.length} rung(s) produced a number, so no rate can be computed. The probe must assign a NUMBER to \`result\`.`,
            );
            if (errs) lines.push('', errs);
            lines.push('');
            continue;
          }
          anyUsable = true;

          const usableXs: number[] = [];
          const usableYs: number[] = [];
          rungs.forEach((r, i) => {
            if (r.value != null) {
              usableXs.push(xs[i]);
              usableYs.push(r.value);
            }
          });
          const fit = linearFit(usableXs, usableYs);
          const first = usableYs[0];
          const last = usableYs[usableYs.length - 1];
          const delta = last - first;

          const rows = rungs.map((r, i) => [
            r.label,
            perCycleKnown ? formatNumber(xs[i]) : String(i),
            r.value != null
              ? formatNumber(r.value)
              : `(${r.error ?? 'no value'})`,
            r.value != null && i > 0 && rungs[i - 1].value != null
              ? formatNumber(r.value - (rungs[i - 1].value as number))
              : '',
          ]);
          lines.push(
            markdownTable(
              [
                'Rung',
                perCycleKnown ? 'Cycles' : 'Index',
                'Value',
                'Δ vs prev',
              ],
              rows,
            ),
          );
          lines.push('');
          lines.push(
            `**${formatNumber(first)} → ${formatNumber(last)}** (Δ ${delta >= 0 ? '+' : ''}${formatNumber(delta)}) across ${usable.length} usable rung(s).`,
          );
          if (perCycleKnown) {
            lines.push(
              `**Rate: ${fit.slope >= 0 ? '+' : ''}${fit.slope.toFixed(3)} per cycle**, r2 = ${fit.r2.toFixed(4)}.`,
            );
            // Skip the caveat on a completely flat series: no choice of
            // x-axis changes a rate of 0 or an r2 of 1, so the note is
            // pure noise exactly where it cannot matter.
            const flatSeries = Math.min(...usableYs) === Math.max(...usableYs);
            if (axisAssumed && !flatSeries) {
              lines.push(
                `_Cycle axis ASSUMED evenly spaced: ${formatNumber(cycles ?? 0)} cycles ` +
                  `split equally across ${usable.length} rung(s). If the ladder was ` +
                  'driven at uneven cycle counts, both the rate and r2 above are ' +
                  'against the wrong x-axis — pass `cycles_per_rung` with the real ' +
                  'per-rung counts._',
              );
            }
          } else {
            lines.push(
              `**Slope: ${fit.slope >= 0 ? '+' : ''}${fit.slope.toFixed(3)} per rung**, r2 = ${fit.r2.toFixed(4)}. ` +
                'Pass `cycles` or `cycles_per_rung` to get a per-cycle rate, which is the unit a leak is quoted in.',
            );
          }
          lines.push('');
          lines.push(`**Verdict:** ${verdictFor(usableYs, fit, axisAssumed)}`);
          if (usable.length === 2) {
            // A line through two points fits them perfectly, so r2 is 1.0000 by
            // construction and "grew every step" is the same statement as "grew".
            // Measured: a 2-rung probe reported detached DOM as
            // "LINEAR, r2 = 1.0000, +0.927/cycle" on the same population a
            // 4-rung probe had just reported FLAT at 880 -> 880. The verdict
            // wording is exactly as confident in both cases, which is what makes
            // it dangerous. `memlab_leak_report` already warns at n=2; this did not.
            lines.push(
              '',
              '> ⚠️ **Only 2 rungs: r2 is 1.0000 by construction** and the verdict above carries no more ' +
                'information than the sign of the delta. A line through two points always fits. Add a third ' +
                'rung before treating this as a rate — and if a longer ladder of the same population ' +
                'disagreed, believe the longer one.',
            );
          }

          const failed = rungs.filter(r => r.error != null);
          if (failed.length > 0) {
            lines.push('');
            lines.push(
              `_${failed.length} rung(s) produced no value and were excluded from the fit:_`,
            );
            for (const f of failed) lines.push(`- ${f.label}: ${f.error}`);
          }
          lines.push('');
        }

        if (!anyUsable) {
          return errorResult(
            new Error(
              `No metric produced two usable rungs, so nothing can be fitted. See the per-metric errors above; the probe must assign a NUMBER to \`result\`.`,
            ),
          );
        }

        lines.push(
          '_A rate is not a cause. Confirm the population with `memlab_retainer_trace` / `memlab_retainer_layers` ' +
            'on a sample before calling it a leak — and check `memlab_dev_artifacts`, since a dev-only population ' +
            'grows just as linearly as a real one._',
        );

        return toolResult(
          lines.join('\n'),
          pathsHeader(locals.map(r => r.label)),
        );
      } catch (e) {
        return errorResult(e instanceof Error ? e : new Error(String(e)));
      }
    },
  );
}
