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

export function verdictFor(values: number[], fit: LinearFit): string {
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
  if (strictlyIncreasing) return 'grew every step (but not a clean line)';
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

async function probeOne(
  localPath: string,
  code: string,
  timeoutMs: number,
  maxNodes: number,
): Promise<{value: number | null; error: string | null}> {
  try {
    return await withSnapshotAt(localPath, async () => {
      const out = await runEval({
        mode: 'eval',
        code,
        timeout_ms: timeoutMs,
        max_nodes: maxNodes,
      });
      const text = textOf(out);
      const value = extractNumber(text);
      if (value == null) {
        return {
          value: null,
          error: `probe did not yield a number (got: ${text.slice(0, 120) || 'empty'})`,
        };
      }
      return {value, error: null};
    });
  } catch (e) {
    return {value: null, error: e instanceof Error ? e.message : String(e)};
  }
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
        .describe(
          'JavaScript run against each rung, exactly as in memlab_eval, which must assign a NUMBER to `result` — e.g. `result = helpers.byClass("OpusRecorder").length`. A one-key object such as {count: n} is also accepted.',
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

        const {rungs: locals, largestMB} = resolveRungs(
          resolved,
          max_file_size_mb,
        );
        const effectiveTimeout = scaledTimeoutMs(largestMB, timeout_ms);

        const rungs: Rung[] = [];
        for (const {label: rungLabel, localPath} of locals) {
          // Per rung, not once: the budget is a wall clock, so a six-rung
          // ladder would otherwise spend rung 1's allowance and starve rung 6.
          armScanBudgetFor(effectiveTimeout);
          const {value, error} = await probeOne(
            localPath,
            code,
            effectiveTimeout,
            max_nodes,
          );
          rungs.push({label: rungLabel, localPath, value, error});
        }

        const usable = rungs.filter(
          (r): r is Rung & {value: number} => r.value != null,
        );
        if (usable.length < 2) {
          const errs = rungs
            .filter(r => r.error != null)
            .map(r => `  ${r.label}: ${r.error}`)
            .join('\n');
          return errorResult(
            new Error(
              `Only ${usable.length} rung(s) produced a number, so no rate can be computed.\n${errs}\n` +
                'The probe must assign a NUMBER to `result`.',
            ),
          );
        }

        const xs: number[] = rungs.map((_, i) => {
          if (cycles_per_rung != null) return cycles_per_rung[i];
          if (cycles != null) {
            return (cycles * i) / (rungs.length - 1);
          }
          return i;
        });
        const usableXs: number[] = [];
        const usableYs: number[] = [];
        rungs.forEach((r, i) => {
          if (r.value != null) {
            usableXs.push(xs[i]);
            usableYs.push(r.value);
          }
        });
        const fit = linearFit(usableXs, usableYs);
        const perCycleKnown = cycles != null || cycles_per_rung != null;

        const first = usableYs[0];
        const last = usableYs[usableYs.length - 1];
        const delta = last - first;

        const header = label != null ? `\`${label}\`` : 'probe';
        const lines: string[] = [];
        lines.push(`## Ladder probe — ${header}`);
        lines.push('');

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
            ['Rung', perCycleKnown ? 'Cycles' : 'Index', 'Value', 'Δ vs prev'],
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
        } else {
          lines.push(
            `**Slope: ${fit.slope >= 0 ? '+' : ''}${fit.slope.toFixed(3)} per rung**, r2 = ${fit.r2.toFixed(4)}. ` +
              'Pass `cycles` or `cycles_per_rung` to get a per-cycle rate, which is the unit a leak is quoted in.',
          );
        }
        lines.push('');
        lines.push(`**Verdict:** ${verdictFor(usableYs, fit)}`);

        const failed = rungs.filter(r => r.error != null);
        if (failed.length > 0) {
          lines.push('');
          lines.push(
            `_${failed.length} rung(s) produced no value and were excluded from the fit:_`,
          );
          for (const f of failed) lines.push(`- ${f.label}: ${f.error}`);
        }
        lines.push('');
        lines.push(
          '_A rate is not a cause. Confirm the population with `memlab_retainer_trace` / `memlab_retainer_layers` ' +
            'on a sample before calling it a leak — and check `memlab_dev_artifacts`, since a dev-only population ' +
            'grows just as linearly as a real one._',
        );

        return toolResult(lines.join('\n'));
      } catch (e) {
        return errorResult(e instanceof Error ? e : new Error(String(e)));
      }
    },
  );
}
