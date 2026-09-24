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
import {
  describeCycleAxis,
  ladderSpanSeconds,
  resolveLadderInputs,
  describeSegmentSelection,
  SEGMENT_ARG_DESCRIPTION,
  retentionWindowCaveat,
  isSettleRungFilename,
} from '../run-manifest.js';

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
  visibilityVerified = false,
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
  if (min === max) {
    // Zero at every rung is the one series this tool CANNOT interpret on its
    // own, because two very different situations produce byte-identical output:
    // the population genuinely does not grow, or the probe cannot observe the
    // population at all and is reporting the absence of its own reach.
    //
    // The second is not hypothetical. A probe written with `shapeKeys` against
    // React Scheduler's `timerQueue` returned 0 at every rung of a real ladder
    // while the population was in the tens of thousands — the array is a
    // CLOSURE-CAPTURED variable, which is not a property of any object, so no
    // amount of property or shape matching can see it. A sibling probe counting
    // Set entries returned 23 for a population of the same order. Both read as
    // clean negatives and one of them nearly closed a round.
    //
    // So an all-zero series is reported as UNKNOWN unless the caller supplied a
    // `visibility_probe` that came back non-zero, which is the only evidence
    // available that this probe family can see anything here at all.
    if (max === 0 && !visibilityVerified) {
      return (
        'UNKNOWN — 0 at every rung, and the visibility control ALSO returned ' +
        '0, so this heap did not answer either probe. That is the signature of ' +
        'a snapshot the probes cannot read (a light load, a truncated capture), ' +
        'not of a clean population. Do NOT record this as a negative result.'
      );
    }
    return max === 0
      ? 'FLAT — 0 at every rung, and the visibility control confirmed a probe ' +
          'CAN observe a non-zero population on this ladder, so this is a ' +
          'verified negative rather than a blind one. Note the control only ' +
          'proves the snapshot is readable; if `code` reaches its population ' +
          'through closure capture (invisible to property/shape matching), ' +
          'pass a `visibility_probe` that uses the SAME access path'
      : 'FLAT — identical at every rung';
  }
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
 * What to show when a probe returned something other than a number.
 *
 * A blanket `slice(0, 120)` cut the most useful failure in half. `helpers.foo
 * does not exist` errors carry the full helper list and a "did you mean" —
 * exactly what recovery needs — and truncating them at 120 chars ended a
 * measured session mid-identifier (`...byTypename, classCo`), so the agent had
 * to spend a separate `describe_env` round trip to learn the API. Errors are
 * kept whole; ordinary output is still clipped, on a boundary.
 */
export function summarizeProbeText(text: string): string {
  const t = text.trim();
  if (t === '') return 'empty';
  // The recovery information IS the message; never clip it.
  if (/does not exist|is not a function|is not defined|SyntaxError/.test(t)) {
    return t;
  }
  if (t.length <= 200) return t;
  const cut = t.slice(0, 200);
  const lastBreak = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  return `${cut.slice(0, lastBreak > 120 ? lastBreak : 200)}…`;
}

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
                  error: `probe did not yield a number (got: ${summarizeProbeText(text)})`,
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
      run_dir: z
        .string()
        .optional()
        .describe(
          "A leak-hunt round's output directory (the one holding run.json and snapshots/). PREFERRED over `paths`: the rung paths, the exact per-rung cycle counts and the total cycles driven are all read from run.json, so the x-axis is measured rather than assumed. Rungs are placed on a schedule, so a real ladder is unevenly spaced (e.g. 0/200/375/450) and an assumed-even axis silently reports wrong rates.",
        ),
      segment: z
        .union([z.number().int().nonnegative(), z.literal('all')])
        .optional()
        .describe(SEGMENT_ARG_DESCRIPTION),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Ordered snapshot paths, oldest rung first. Local paths, manifold:// URLs, bare filenames, or a single ["ladder:<name>"] reference. Ignored when `run_dir` is given. When these are named `rung_NN_cNNN.heapsnapshot` the cycle axis is recovered from the filenames.',
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
      // Accepts an ARRAY too, and treats it as `cycles_per_rung`. The two
      // ladder tools disagreed on this one parameter's type — memlab_leak_report
      // required an array and rejected a scalar, this one required a scalar and
      // rejected an array — so a caller moving between the two, which the skill
      // recipe asks for on every round, hit a validation error in each
      // direction. Neither type is wrong; accept both on both.
      cycles: z
        .union([z.number(), z.array(z.number())])
        .optional()
        .describe(
          'Interaction cycles driven between the FIRST and LAST rung. When given, the rate is reported per cycle (the number a leak is actually quoted in) and the fit is against cycle count rather than rung index. Rungs are assumed evenly spaced in cycles unless cycles_per_rung is given. An ARRAY is accepted as an alias for cycles_per_rung (the exact cumulative count at each rung), which is the form memlab_leak_report takes.',
        ),
      cycles_per_rung: z
        .array(z.number())
        .optional()
        .describe(
          'Exact cumulative cycle count at each rung, when the ladder is NOT evenly spaced (the common case — rungs are placed on a schedule, not at equal intervals). Must match `paths` in length; overrides `cycles`.',
        ),
      visibility_probe: z
        .string()
        .optional()
        .describe(
          'A CONTROL expression, evaluated on every rung exactly like `code`, whose value MUST be non-zero on a healthy heap — e.g. `result = helpers.byClass("Object").length`. Its only job is to answer "can a probe of this kind see anything here?". Without it, a series of 0 at every rung is reported as UNKNOWN rather than as a negative, because a probe that cannot reach its population (closure-captured variables are invisible to property/shape matching) returns exactly the same zeros as a population that never grew. Supply it whenever a zero result would be recorded as "no leak here".',
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
      run_dir,
      segment,
      paths,
      code,
      metrics,
      cycles,
      cycles_per_rung,
      visibility_probe,
      label,
      timeout_ms,
      max_nodes,
      max_file_size_mb,
    }) => {
      try {
        // An array in `cycles` IS a per-rung axis; normalise before anything
        // reads it, so the rest of the tool keeps seeing a scalar.
        let cyclesScalar: number | undefined;
        let axisCameFromCycles = false;
        if (Array.isArray(cycles)) {
          // Two spellings of the axis must not become two axes. Preferring one
          // and dropping the other fits the rate against an x-axis the caller
          // did not ask for, and the output cannot show that it happened.
          if (cycles_per_rung != null) {
            return errorResult(
              new Error(
                'An array in `cycles` IS `cycles_per_rung` — pass one or the other. Both were given, and silently choosing between them would fit the rate against an axis you did not write.',
              ),
            );
          }
          cycles_per_rung = cycles;
          cyclesScalar = undefined;
          // Remembered so a length-mismatch error can name the argument the
          // caller actually wrote. Post-normalisation the message said
          // `cycles_per_rung`, which appears nowhere in their call.
          axisCameFromCycles = true;
        } else {
          cyclesScalar = cycles;
        }
        // One place decides the x-axis for every trend tool; see
        // ../run-manifest.ts for why reconstructing it per caller is unsafe.
        let inputs;
        try {
          inputs = resolveLadderInputs({
            run_dir,
            segment,
            paths,
            cycles: cyclesScalar,
            cycles_per_rung,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Only the length-mismatch message is rewritten, and only when the
          // axis came from `cycles`. Rewriting every throw replaced unrelated
          // failures (a missing `run_dir`, a bad `segment`) with a new Error
          // that lost the original type and stack.
          if (axisCameFromCycles && msg.startsWith('cycles_per_rung')) {
            throw new Error(
              msg.replace(/^cycles_per_rung/, '`cycles` (as an array)'),
            );
          }
          throw e;
        }
        const {paths: resolved} = resolveLadderPaths(inputs.paths);
        cycles_per_rung = inputs.cyclesPerRung ?? undefined;
        // A single narrowed scalar from here down. `cycles` is a
        // number|number[] union at the parameter, and reassigning the resolved
        // scalar back into it leaves every later arithmetic use fighting the
        // array arm of the union.
        const cyclesResolved: number | undefined = inputs.cycles;
        const axisSource = inputs.source;
        const ladderSpanS =
          inputs.spanSeconds ?? ladderSpanSeconds(inputs.manifest);
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

        // The control rides along as an ordinary metric so it shares the rung
        // loads — the whole reason this tool batches. `probeRung` keys outcomes
        // by metric NAME, so the control uses a sentinel a caller cannot type as
        // a JSON key by accident; a collision with someone's `label` or `metrics`
        // key would merge the control's series into a reported one and silently
        // corrupt both.
        const VISIBILITY_METRIC = '<<memlab:visibility-control>>';
        const reportedCount = metricList.length;
        const callerVisibilityProbe =
          visibility_probe != null && visibility_probe.trim() !== '';
        // Run a control ALWAYS, not only when asked. Without one, an all-zero
        // series can only be reported as UNKNOWN — "does not grow" and "this
        // probe is blind" produce identical numbers — and that verdict is the
        // caller's to resolve, usually by driving another whole round. The
        // control rides along as an extra metric inside the SAME rung loads and
        // is an indexed lookup, so the cost is negligible against a
        // hundreds-of-megabytes parse; the default turns most UNKNOWNs into a
        // definite verdict for free. A caller-supplied probe is strictly better
        // (it can be chosen to exercise the same access path as `code`), so it
        // still wins when given.
        const DEFAULT_VISIBILITY_PROBE =
          "result = helpers.byClass('Object').length";
        const visibilityCode = callerVisibilityProbe
          ? (visibility_probe as string)
          : DEFAULT_VISIBILITY_PROBE;
        const hasVisibilityProbe = true;
        metricList.push({name: VISIBILITY_METRIC, code: visibilityCode});

        const {rungs: locals, largestMB} = resolveRungs(
          resolved,
          max_file_size_mb,
        );
        const effectiveTimeout = scaledTimeoutMs(largestMB, timeout_ms);

        // Parallel to metricList by INDEX rather than keyed by name: a name is
        // not guaranteed unique (a `label` can collide with a `metrics` key),
        // and a keyed map would silently merge two series into one.
        const perMetric: Rung[][] = metricList.map(() => []);
        let rungIndex = 0;
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

          // Fail fast on a ladder that cannot answer anything. A typo'd helper
          // is not detectable until a probe RUNS, and a measured session spent
          // a full four-rung pass on 300-500 MB captures to be told three of
          // four metrics referenced helpers that do not exist. Rung 0 already
          // knows that; the remaining rungs only make the same discovery more
          // expensive. Some metrics failing is fine — the survivors still earn
          // the pass — but all of them failing means there is nothing to learn.
          if (rungIndex === 0) {
            const firstRung = perMetric.map(rows => rows[0]);
            const allFailed =
              firstRung.length > 0 && firstRung.every(r => r?.value == null);
            if (allFailed) {
              const detail = metricList
                .map(
                  (m, mi) =>
                    `- \`${m.name}\`: ${firstRung[mi]?.error ?? 'no value'}`,
                )
                .join('\n');
              return errorResult(
                new Error(
                  `every probe failed on the FIRST rung, so the remaining ${
                    locals.length - 1
                  } rung(s) were not loaded (each is a full pass over a multi-hundred-MB graph).\n\n` +
                    `${detail}\n\n` +
                    'Fix the probe(s) and re-run. `memlab_eval({mode:"describe_env"})` lists the helper API.',
                ),
              );
            }
          }
          rungIndex++;
        }

        const xsFor = (n: number): number[] =>
          Array.from({length: n}, (_, i) => {
            if (cycles_per_rung != null) return cycles_per_rung[i];
            if (cyclesResolved != null) return (cyclesResolved * i) / (n - 1);
            return i;
          });
        const perCycleKnown = cyclesResolved != null || cycles_per_rung != null;
        // `cycles` alone spreads the rungs evenly over the range. That is a
        // guess about how the ladder was driven, and it silently becomes the
        // x-axis every fit is scored against.
        const axisAssumed =
          axisSource === 'assumed-even' ||
          (cyclesResolved != null && cycles_per_rung == null);

        // A control that came back non-zero anywhere proves a probe of this
        // kind can observe this heap; that is the whole claim, so one rung is
        // enough to establish it.
        const visibilityIndex = hasVisibilityProbe
          ? metricList.findIndex(m => m.name === VISIBILITY_METRIC)
          : -1;
        const visibilityValues =
          visibilityIndex >= 0 ? perMetric[visibilityIndex] : [];
        const visibilityVerified = visibilityValues.some(
          r => r.value != null && r.value !== 0,
        );
        const visibilityBlind =
          hasVisibilityProbe &&
          visibilityValues.length > 0 &&
          !visibilityVerified;

        const lines: string[] = [];
        const multi = reportedCount > 1;
        lines.push(
          multi
            ? `## Ladder probe — ${reportedCount} metrics over ${locals.length} rungs`
            : `## Ladder probe — \`${metricList[0].name}\``,
        );
        lines.push('');
        if (multi) {
          lines.push(
            `_All ${reportedCount} metrics were measured in a single pass over the ladder — each rung was loaded once._`,
          );
          lines.push('');
        }
        // State how the axis was obtained. A reader cannot otherwise tell a
        // measured axis from an assumed one, and the tables look identical.
        lines.push(describeCycleAxis(axisSource, cycles_per_rung ?? null));
        const segmentNote = describeSegmentSelection(
          inputs.segment,
          inputs.manifest,
        );
        if (segmentNote != null) lines.push(segmentNote);
        lines.push('');
        if (visibilityBlind) {
          lines.push(
            '> ⚠️ **The visibility control itself never returned a non-zero value.** ' +
              'It was supposed to be non-zero on any healthy heap, so the likely reading is ' +
              'that probes of this kind cannot reach anything here — a wrong snapshot, a ' +
              'helper that does not apply to this heap, or an expression that never ran. ' +
              'Treat EVERY series below as unverified, including the non-zero ones.',
            '',
          );
        }

        let anyUsable = false;
        let allMetricsFlat = true;
        for (let mi = 0; mi < reportedCount; mi++) {
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
          const usableIsSettle: boolean[] = [];
          rungs.forEach((r, i) => {
            if (r.value != null) {
              usableXs.push(xs[i]);
              usableYs.push(r.value);
              usableIsSettle.push(isSettleRungFilename(r.label));
            }
          });
          // The settle rung sits at the SAME cycle count as the rung before it,
          // so it is a second y at one x. The fit and the shape verdict have to
          // agree about whether it counts, and the answer is that it does not:
          // a rate is a statement about DRIVEN cycles, and a settle y that
          // differs from the driven one (it usually does — a GC ran) drags the
          // slope while the verdict describes the driven rungs only.
          // Deduped by VALUE, not by adjacency: a hand-supplied list can
          // repeat an x non-consecutively, and an adjacency test keeps both
          // copies. At a shared x the DRIVEN rung wins regardless of order —
          // keeping whichever came first assumed the settle is always last,
          // and a settle listed first would have fitted the GC'd value while
          // discarding the driven one.
          const keepAt = new Map<number, number>();
          usableXs.forEach((x, i) => {
            const held = keepAt.get(x);
            if (held == null || (usableIsSettle[held] && !usableIsSettle[i])) {
              keepAt.set(x, i);
            }
          });
          const distinct = usableXs.map((x, i) => keepAt.get(x) === i);
          const fitXs = usableXs.filter((_, i) => distinct[i]);
          const fitYs = usableYs.filter((_, i) => distinct[i]);
          const droppedRepeatedX = usableXs.length - fitXs.length;
          const fit = linearFit(fitXs, fitYs);
          // One distinct x is not a ladder. linearFit on a single point
          // reports slope 0 / r2 1.0000, which reads as a measured, perfectly
          // clean rate — the most confident possible way to say nothing.
          const singleX = fitXs.length < 2;
          // Normally the header states what the fit used, so it cannot read
          // "10 → 10 (Δ +0)" beside a positive rate when the settle y differs.
          // On a degenerate axis the deduped series collapses to ONE point, and
          // reporting from it would claim Δ +0 and FLAT over a table that
          // visibly grows — so there the header describes what the reader can
          // see, and the verdict is withheld instead.
          const headerYs = singleX ? usableYs : fitYs;
          const first = headerYs[0];
          const last = headerYs[headerYs.length - 1];
          const delta = last - first;
          const seriesFlat = Math.min(...headerYs) === Math.max(...headerYs);
          if (!seriesFlat) allMetricsFlat = false;

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
          // `singleX` is tested FIRST: when both apply, the assumed-axis text
          // tells the reader to pass `run_dir`/`cycles_per_rung`, which fixes
          // nothing if every rung shares one cycle count. Same withheld rate,
          // wrong remedy.
          if (singleX) {
            lines.push(
              `**RATE UNAVAILABLE** — the ${formatNumber(usableXs.length)} usable rung(s) share a single cycle count (${formatNumber(fitXs[0] ?? 0)}), so there is no x-axis to fit against. A slope from one distinct x is 0 with r2 = 1.0000 and means nothing. Capture rungs at different cycle counts, or pass the real \`cycles_per_rung\`.`,
            );
          } else if (perCycleKnown && axisAssumed && !seriesFlat) {
            // DO NOT print a rate against a guessed x-axis. The old behaviour
            // printed the rate and the r2 in bold and put the caveat
            // underneath, which reads as boilerplate — and the numbers are not
            // approximately right, they are wrong: a measured ladder read
            // `+2.135/cycle, r2 = 0.9424` assumed-even against `+2.000/cycle,
            // r2 = 1.0000` on its true axis, which is a different VERDICT
            // ("episodic" vs "dead linear"), not a rounding difference.
            //
            // A number that is wrong is worse than no number, so withhold it
            // and say exactly how to get the real one. The series itself is
            // printed above and is unaffected by the axis.
            lines.push(
              '**RATE UNAVAILABLE — the cycle axis is assumed, not measured.** ' +
                `\`cycles: ${formatNumber(cyclesResolved ?? 0)}\` was split evenly across ` +
                `${usable.length} rung(s), but rungs are placed on a schedule and a real ` +
                'ladder is rarely evenly spaced. Re-run with `run_dir` (the axis is then ' +
                'read from run.json) or pass `cycles_per_rung` with the real per-rung ' +
                'counts. The series above is correct either way.',
            );
          } else if (perCycleKnown) {
            lines.push(
              `**Rate: ${fit.slope >= 0 ? '+' : ''}${fit.slope.toFixed(3)} per cycle**, r2 = ${fit.r2.toFixed(4)}.` +
                (droppedRepeatedX > 0
                  ? ` _(fitted on ${fitXs.length} rung(s) at distinct cycle counts; ${droppedRepeatedX} rung(s) repeat a cycle count already present and are excluded from the fit and the verdict. Usually that is the settle rung — read it with \`memlab_settle_check\` — but a hand-supplied \`cycles_per_rung\` with a duplicate drops a DRIVEN rung the same way.)_`
                  : ''),
            );
          } else {
            lines.push(
              `**Slope: ${fit.slope >= 0 ? '+' : ''}${fit.slope.toFixed(3)} per rung**, r2 = ${fit.r2.toFixed(4)}. ` +
                'Pass `cycles` or `cycles_per_rung` to get a per-cycle rate, which is the unit a leak is quoted in.',
            );
          }
          lines.push('');
          // The SHAPE verdict is judged on rungs at distinct cycle counts.
          //
          // The settle rung sits at the same cycle count as the last driven
          // rung, because the settle drives nothing — so it is flat by
          // construction and contributed a phantom "flat step" to every ladder
          // that had one. Since the runner appends a settle rung by default,
          // that was every properly-run round: a dead-linear series read back
          // as "non-decreasing but NOT strictly increasing … growth is
          // episodic".
          const shapeYs = fitYs;
          const verdictText = singleX
            ? 'UNMEASURABLE AXIS — every rung shares one cycle count, so the series has no shape to read. The values above are real; the trend is not derivable from them.'
            : verdictFor(shapeYs, fit, axisAssumed, visibilityVerified);
          lines.push(`**Verdict:** ${verdictText}`);
          // LINEAR is the verdict most often read as "unbounded leak". Over a
          // ladder shorter than the app's retention window it is equally
          // consistent with a bounded working set.
          if (/LINEAR/.test(verdictText)) {
            lines.push('');
            lines.push(retentionWindowCaveat(ladderSpanS));
          }
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

        // Every metric flat across three or more rungs is worth stopping on. A
        // driven surface moves SOMETHING — even a clean one churns caches and
        // scheduler records — so a ladder where nothing at all changed is more
        // often a harness that stopped driving than an app with no growth.
        //
        // Measured: three consecutive rounds of a real hunt were voided after
        // the page silently logged out mid-run. The hammer found no opener, the
        // ladder froze flat, and the output was indistinguishable from a clean
        // surface. They were only caught because the number was implausibly
        // stable. The natural output of that failure is a FALSE NEGATIVE, which
        // is the most expensive thing this tool can emit.
        if (allMetricsFlat && anyUsable && locals.length >= 3) {
          lines.push(
            `> ⚠️ **SUSPECT — every metric was flat across all ${locals.length} rungs.** ` +
              'That can mean the surface is clean, but it is also exactly what a harness ' +
              'that stopped driving the app produces: a logged-out page, a selector that ' +
              'stopped matching, or an interaction that silently no-ops still yields a ' +
              'perfectly stable ladder. Before recording a negative, confirm the run ' +
              'actually drove the app — a per-cycle mount/unmount or node-count delta, and ' +
              'a logged-in assertion at the LAST rung, not just the first.',
            '',
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
