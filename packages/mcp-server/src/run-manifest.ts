/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * Read a leak-hunt round's `run.json` and hand every ladder tool the same
 * x-axis.
 *
 * Every trend tool needs three things that already exist in the manifest the
 * hunt runner writes: the ordered rung paths, the cumulative cycle count at each
 * rung, and the total cycles driven. Until now each caller re-derived them by
 * hand, and the natural way to do that is wrong.
 *
 * A rung is placed on a SCHEDULE — on cycle intervals, time intervals, or the
 * session deadline — so a real four-rung ladder is spaced like
 * `[0, 200, 375, 450]`, not `[0, 150, 300, 450]`. A measured session computed
 * the axis as `i * total / (n - 1)`, passed the round's TARGET cycle count
 * (600) instead of the count actually driven (450), and every per-cycle rate in
 * that analysis was wrong by up to 33% with a linear fit against the wrong
 * x-axis. Nothing in the output looked different: the tables render identically
 * whether the axis is right or wrong, which is the whole problem.
 *
 * So the axis is read from the manifest rather than reconstructed, and when a
 * caller does supply paths by hand the cycle counts are recovered from the
 * `rung_NN_cNNN.heapsnapshot` filenames before falling back to even spacing.
 * Whichever route was taken is stated in the report, because a reader cannot
 * otherwise tell an assumed axis from a measured one.
 */

import fs from 'fs';
import path from 'path';

/** How the per-rung cycle axis was obtained, for disclosure in the report. */
export type CycleAxisSource =
  | 'manifest' // read from run.json — exact
  | 'caller' // caller passed cycles_per_rung explicitly
  | 'filenames' // parsed from rung_NN_cNNN.heapsnapshot
  | 'assumed-even' // no better information; evenly spaced
  | 'none'; // no cycle information at all; x-axis is rung index

export interface RunManifest {
  /** Ordered rung snapshot paths, oldest first. */
  paths: string[];
  /** Cumulative cycles driven at each rung. Same length as `paths`. */
  cyclesPerRung: number[];
  /** Total cycles actually driven (`totals.cycles`), not the target. */
  cycles: number;
  /** Wall-clock seconds the ladder spans, when the manifest records it. */
  wallClockSeconds: number | null;
  /** Wall clock at each rung, so a SEGMENT can report its own span. */
  elapsedPerRung: Array<number | null>;
  /** Rung indices after which the runner detected a ladder split. */
  splitAfterRung: number[];
  /** Caveats the runner recorded, verbatim. */
  caveats: string[];
  /** Combos driven, for the report header. */
  combos: string[];
}

/** `rung_02_c375.heapsnapshot` -> 375. */
export function cyclesFromFilename(p: string): number | null {
  const m = /rung_\d+_c(\d+)\b/i.exec(path.basename(p));
  return m ? Number(m[1]) : null;
}

/**
 * Recover the cycle axis for a hand-supplied path list.
 *
 * Returns `assumed-even` only when the filenames carry no cycle counts, and
 * says so, rather than quietly producing a plausible-looking axis.
 */
export function deriveCycleAxis(
  paths: string[],
  cyclesPerRung: number[] | undefined,
  cycles: number | undefined,
): {axis: number[] | null; source: CycleAxisSource} {
  if (cyclesPerRung != null && cyclesPerRung.length === paths.length) {
    return {axis: cyclesPerRung, source: 'caller'};
  }
  const fromNames = paths.map(cyclesFromFilename);
  if (fromNames.every(v => v != null)) {
    const axis = fromNames as number[];
    // Only trust filenames if they are non-decreasing; a shuffled list would
    // otherwise produce a fit against a scrambled x-axis.
    const monotonic = axis.every((v, i) => i === 0 || v >= axis[i - 1]);
    if (monotonic) return {axis, source: 'filenames'};
  }
  if (cycles != null && paths.length > 1) {
    const step = cycles / (paths.length - 1);
    return {
      axis: paths.map((_, i) => Math.round(i * step)),
      source: 'assumed-even',
    };
  }
  return {axis: null, source: 'none'};
}

/** One line for the report, so an assumed axis is never mistaken for a measured one. */
export function describeCycleAxis(
  source: CycleAxisSource,
  axis: number[] | null,
): string {
  const shown = axis ? `[${axis.join(', ')}]` : 'rung index';
  switch (source) {
    case 'manifest':
      return `_Cycle axis ${shown} read from run.json (exact)._`;
    case 'caller':
      return `_Cycle axis ${shown} as supplied._`;
    case 'filenames':
      return `_Cycle axis ${shown} parsed from rung filenames._`;
    case 'assumed-even':
      return (
        `_Cycle axis ${shown} **ASSUMED EVENLY SPACED** — the hunt runner places rungs on a ` +
        `schedule, so a real ladder usually is not. Pass \`run_dir\` (or \`cycles_per_rung\`) ` +
        `for the measured axis; every per-cycle rate below is wrong if the real spacing differs._`
      );
    default:
      return '_No cycle information; rates are per rung, not per cycle._';
  }
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
}

/**
 * Load `run.json` from a hunt output directory (or a direct path to the file).
 *
 * Throws with an actionable message rather than returning a partial manifest —
 * a half-read manifest would reintroduce exactly the silent-wrong-axis problem
 * this module exists to remove.
 */
export function loadRunManifest(runDir: string): RunManifest {
  const file = runDir.endsWith('.json')
    ? runDir
    : path.join(runDir, 'run.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      `no run.json at ${file}. Pass the hunt's output directory (the one holding run.json and snapshots/), or supply paths + cycles_per_rung by hand.`,
    );
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (e: unknown) {
    throw new Error(`run.json at ${file} is not valid JSON: ${String(e)}`);
  }

  const rungs = Array.isArray(raw.rungs) ? raw.rungs : [];
  if (rungs.length === 0) {
    throw new Error(
      `run.json at ${file} lists no rungs. The round captured no ladder; there is nothing to analyze.`,
    );
  }

  const paths: string[] = [];
  const cyclesPerRung: number[] = [];
  const elapsedPerRung: Array<number | null> = [];
  for (const r of rungs as Array<Record<string, unknown>>) {
    if (typeof r.path !== 'string') {
      throw new Error(
        `run.json rung entry has no string \`path\`: ${JSON.stringify(r)}`,
      );
    }
    paths.push(r.path);
    cyclesPerRung.push(typeof r.cycles === 'number' ? r.cycles : NaN);
    elapsedPerRung.push(typeof r.elapsed_s === 'number' ? r.elapsed_s : null);
  }

  // A rung without a recorded cycle count would poison the fit silently.
  if (cyclesPerRung.some(Number.isNaN)) {
    throw new Error(
      `run.json at ${file} has a rung with no numeric \`cycles\`; cannot build a cycle axis.`,
    );
  }

  const totals = (raw.totals ?? {}) as Record<string, unknown>;
  const cycles =
    typeof totals.cycles === 'number'
      ? totals.cycles
      : cyclesPerRung[cyclesPerRung.length - 1];

  const elapsed = typeof raw.elapsed_s === 'number' ? raw.elapsed_s : null;

  return {
    paths,
    cyclesPerRung,
    cycles,
    wallClockSeconds: elapsed,
    elapsedPerRung,
    splitAfterRung: Array.isArray(raw.ladder_splits_after_rung)
      ? (raw.ladder_splits_after_rung as unknown[]).filter(
          (n): n is number => typeof n === 'number',
        )
      : [],
    caveats: asStringArray(raw.caveats),
    combos: asStringArray(
      (raw.config as Record<string, unknown> | undefined)?.combos,
    ),
  };
}

/** A run of rungs captured inside ONE V8 isolate. */
export interface LadderSegment {
  /** 0-based position in the run, for `segment:` selection. */
  index: number;
  /** Rung indices this segment covers, inclusive. */
  firstRung: number;
  lastRung: number;
  paths: string[];
  cyclesPerRung: number[];
  /**
   * Cycles driven WITHIN the segment, not the absolute count at its last rung.
   * A per-cycle rate divides by this; a segment that starts at cycle 600 and
   * ends at 900 drove 300, and dividing by 900 understates every rate by 3x.
   */
  spanCycles: number;
  /** Wall clock WITHIN the segment, for the retention-window caveat. */
  spanSeconds: number | null;
}

/**
 * Split a ladder at its isolate boundaries.
 *
 * A page reload starts a fresh V8 isolate, so rungs on either side of the split
 * describe different heaps. Differencing across the boundary produced
 * `app_delta -3.6 MB` ("cleanest round on record") where the valid segment of
 * the SAME run read `+2.1 MB`. The runner detects the reload and records it;
 * this turns that record into the per-segment ladders the caveat asks for.
 */
export function ladderSegments(manifest: RunManifest): LadderSegment[] {
  const cuts = [...new Set(manifest.splitAfterRung)]
    .filter(n => n >= 0 && n < manifest.paths.length - 1)
    .sort((a, b) => a - b);
  const bounds = [0, ...cuts.map(n => n + 1), manifest.paths.length];
  const out: LadderSegment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const [from, to] = [bounds[i], bounds[i + 1]];
    if (to <= from) continue;
    const cyclesPerRung = manifest.cyclesPerRung.slice(from, to);
    const startS = manifest.elapsedPerRung[from];
    const endS = manifest.elapsedPerRung[to - 1];
    out.push({
      index: out.length,
      firstRung: from,
      lastRung: to - 1,
      paths: manifest.paths.slice(from, to),
      cyclesPerRung,
      spanCycles: cyclesPerRung[cyclesPerRung.length - 1] - cyclesPerRung[0],
      spanSeconds: startS != null && endS != null ? endS - startS : null,
    });
  }
  return out;
}

/** The `segment` parameter's description, shared so the three ladder tools agree. */
export const SEGMENT_ARG_DESCRIPTION =
  'Which isolate segment of the run to analyze, when the page reloaded mid-ladder. ' +
  'Rungs on either side of a reload live in DIFFERENT V8 isolates and are not comparable — ' +
  'differencing across one produced a 3.6 MB "shrink" where the valid segment read +2.1 MB. ' +
  'Only meaningful with `run_dir`, and only when run.json records a split: then this is REQUIRED, ' +
  'and the error lists the segments. Pass `"all"` to override and treat the whole ladder as one heap.';

/** The `segment:` menu, for an error message or a report header. */
export function describeSegments(segments: LadderSegment[]): string {
  return segments
    .map(
      s =>
        `segment ${s.index}: rungs ${s.firstRung}-${s.lastRung} ` +
        `(${s.paths.length} snapshot${s.paths.length === 1 ? '' : 's'}, ` +
        `cycles ${s.cyclesPerRung[0]}-${
          s.cyclesPerRung[s.cyclesPerRung.length - 1]
        })`,
    )
    .join('; ');
}

/**
 * Resolve the ladder inputs for a tool that accepts EITHER `run_dir` OR
 * `paths`, so the five trend tools cannot drift in how they read the axis.
 *
 * When the run has an isolate split, this REFUSES to return the whole ladder
 * unless the caller says `segment: 'all'`. The runner already emits a caveat
 * saying the segments must not be compared, and it was read and then ignored in
 * four separate rounds — a caveat next to a plausible-looking number does not
 * survive contact with a hurry.
 */
export function resolveLadderInputs(args: {
  run_dir?: string;
  paths?: string[];
  cycles?: number;
  cycles_per_rung?: number[];
  segment?: number | 'all';
}): {
  paths: string[];
  cyclesPerRung: number[] | null;
  cycles: number | undefined;
  source: CycleAxisSource;
  manifest: RunManifest | null;
  segment: LadderSegment | null;
  /**
   * Wall clock the RESOLVED ladder spans — the segment's own span when one is
   * selected, the whole run's otherwise. Callers must prefer this over
   * `manifest.wallClockSeconds`: on a segment the latter is the whole run, and
   * the retention caveat built from it claims a window several times longer
   * than the data can actually observe.
   */
  spanSeconds: number | null;
} {
  if (args.run_dir != null && args.run_dir !== '') {
    const manifest = loadRunManifest(args.run_dir);
    const segments = ladderSegments(manifest);
    if (segments.length > 1 && args.segment !== 'all') {
      if (args.segment == null) {
        throw new Error(
          `this run reloaded the page mid-ladder, so its ${segments.length} segments are ` +
            `DIFFERENT V8 isolates and cannot be compared to each other — a run like this ` +
            `reported a 3.6 MB SHRINK where the valid segment read +2.1 MB. ` +
            `Pass \`segment: <n>\` to analyze one (${describeSegments(segments)}), ` +
            `or \`segment: "all"\` to override and treat the whole ladder as one heap.`,
        );
      }
      const chosen = segments[args.segment];
      if (chosen == null) {
        throw new Error(
          `no segment ${args.segment} in this run. Available: ${describeSegments(segments)}.`,
        );
      }
      return {
        paths: chosen.paths,
        cyclesPerRung: chosen.cyclesPerRung,
        // The SPAN, not the absolute count at the last rung: `cycles` is
        // documented as "driven between the first and last snapshot" and is the
        // denominator of every per-cycle rate.
        cycles: chosen.spanCycles,
        source: 'manifest',
        manifest,
        segment: chosen,
        spanSeconds: chosen.spanSeconds,
      };
    }
    return {
      paths: manifest.paths,
      cyclesPerRung: manifest.cyclesPerRung,
      cycles: manifest.cycles,
      source: 'manifest',
      manifest,
      segment: segments.length === 1 ? segments[0] : null,
      spanSeconds: manifest.wallClockSeconds,
    };
  }
  const paths = args.paths ?? [];
  if (paths.length === 0) {
    throw new Error(
      'pass either `run_dir` (the hunt output directory holding run.json) or `paths`.',
    );
  }
  const {axis, source} = deriveCycleAxis(
    paths,
    args.cycles_per_rung,
    args.cycles,
  );
  return {
    paths,
    cyclesPerRung: axis,
    cycles: args.cycles,
    source,
    manifest: null,
    segment: null,
    spanSeconds: null,
  };
}

/** The header line a segmented run needs, so a partial ladder is never read as the whole run. */
export function describeSegmentSelection(
  segment: LadderSegment | null,
  manifest: RunManifest | null,
): string | null {
  if (segment == null || manifest == null) return null;
  const total = ladderSegments(manifest).length;
  if (total < 2) return null;
  return (
    `_**Segment ${segment.index} of ${total}** (rungs ${segment.firstRung}-${segment.lastRung}). ` +
    `The page reloaded mid-run; the other segments are different V8 isolates and are NOT included ` +
    `in the numbers below._`
  );
}

/**
 * The wall-clock span of a ladder, used to warn that a retention window longer
 * than the span is indistinguishable from unbounded growth.
 */
export function ladderSpanSeconds(manifest: RunManifest | null): number | null {
  return manifest?.wallClockSeconds ?? null;
}

/**
 * The sentence a LINEAR verdict needs when the ladder is short.
 *
 * A measured sweep reported "unbounded leak, r2 = 0.9996" for three populations
 * that are actually bounded by a 30-minute `cleanUpTraceTimeout`. Every round
 * drove for ~20 minutes, so nothing could ever expire and no ladder in that
 * sweep could have observed the plateau. The finding was published and then
 * retracted. A linear fit over a window shorter than the app's retention window
 * is exactly what a bounded working set looks like.
 */
export function retentionWindowCaveat(spanSeconds: number | null): string {
  if (spanSeconds == null) {
    return (
      '_LINEAR over this ladder does not by itself mean UNBOUNDED: a working set bounded by a ' +
      'retention window longer than the ladder is indistinguishable from a leak here. Run ' +
      '`memlab_rate_model`, and `memlab_retention_windows` to see what windows this app actually has._'
    );
  }
  const mins = Math.round(spanSeconds / 6) / 10;
  return (
    `_This ladder spans **${mins} min** of wall clock. A working set bounded by a retention window ` +
    `LONGER than that is indistinguishable from unbounded growth here — a measured sweep published ` +
    `"unbounded" for a population actually bounded by a 30-minute cleanup timer. Run ` +
    `\`memlab_rate_model\`, and \`memlab_retention_windows\` to list this app's windows, before ` +
    `calling anything unbounded._`
  );
}
