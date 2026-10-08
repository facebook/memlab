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
 * Invariants and the judges that check them at rest.
 *
 * An invariant is a plain-words claim about the app ("with nobody interacting,
 * detached DOM goes back to where it started"); its judge is a probe that
 * returns one number per rung plus an expectation about that series. A judge is
 * read at every driven rung AND at the settle rung, because the settle rung is
 * the only capture that tells retention from in-flight backlog.
 *
 * Measuring and judging are separate on purpose: `judgeSeries` is a pure
 * function of the numbers, so the switch matrix and calibration reuse it on
 * their own arms without reloading anything.
 */

import fs from 'fs';
import path from 'path';
import {ladderShape, type LadderShape} from './ladder-shape.js';
import {loadRunManifest} from './run-manifest.js';
import {
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
} from './snapshot-borrow.js';
import {snapshotExists} from './snapshot-index.js';
import {linearFit, probeRung} from './tools/ladder-probe.js';

export type Expectation =
  'no-growth' | 'returns-to-baseline' | 'bounded' | 'zero-at-rest';

const EXPECTATIONS: ReadonlySet<string> = new Set([
  'no-growth',
  'returns-to-baseline',
  'bounded',
  'zero-at-rest',
]);

export interface Invariant {
  name: string;
  /** The claim in plain words, as the person approved it. */
  words: string | null;
  /** `memlab_eval` code assigning one number to `result`. */
  probe: string;
  /** Same access path as `probe`; must be non-zero on a healthy heap. */
  visibilityProbe: string | null;
  expect: Expectation;
  /** `no-growth`: largest per-cycle slope past the first rung that still holds. */
  maxPerCycle: number;
  /** `returns-to-baseline`: allowed rise at rest, relative to the first rung. */
  tolerance: number;
  /** `returns-to-baseline`: allowed rise at rest in absolute units. */
  absTolerance: number;
  /** `bounded` / `zero-at-rest`: ceiling. */
  max: number | null;
  /**
   * The rule (a fix, usually behind a gate) this judge guards. With the rule
   * switched off the judge must go red; `memlab_switch_matrix` checks that.
   */
  rule: string | null;
}

export interface InvariantSpec {
  prelude: string | null;
  invariants: Invariant[];
  /** Where the spec came from, for the report header. */
  source: string;
  /** One line per entry that could not be used, and why. */
  dropped: string[];
  /** Rounds known to carry a leak, and the judges that must go red on each. */
  calibration: CalibrationRound[];
}

export interface CalibrationRound {
  runDir: string;
  red: string[];
  note: string;
}

function parseCalibration(raw: unknown, dropped: string[]): CalibrationRound[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, i) => {
    const o = (entry ?? {}) as Record<string, unknown>;
    const red = Array.isArray(o.red)
      ? o.red.filter((n): n is string => typeof n === 'string')
      : [];
    if (typeof o.run_dir !== 'string' || red.length === 0) {
      dropped.push(
        `calibration #${i}: needs \`run_dir\` and a non-empty \`red\``,
      );
      return [];
    }
    return [
      {runDir: o.run_dir, red, note: typeof o.note === 'string' ? o.note : ''},
    ];
  });
}

export type JudgeVerdict =
  'PASS' | 'LEAK' | 'BACKLOG' | 'UNSETTLED' | 'UNVERIFIED' | 'ERROR';

export interface JudgeOutcome {
  verdict: JudgeVerdict;
  reason: string;
  shape: LadderShape | null;
  /** Per-cycle slope past the first rung, or null with fewer than 2 such rungs. */
  slope: number | null;
  /**
   * Did the judge see its invariant break? True for a LEAK, and for an
   * UNSETTLED judge that grew or crossed its bound on the ladder (no settle
   * rung to confirm it at rest). Callers read this, never the reason text.
   */
  fired: boolean;
  /**
   * Why an UNVERIFIED judge could not decide: too few readable rungs to tell a
   * mount step from growth, or nothing showed the probe can see the
   * population. Unset for every other verdict.
   */
  unverifiedCause?: 'short-ladder' | 'not-visible';
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function parseInvariantSpec(
  raw: unknown,
  source: string,
): InvariantSpec {
  const obj = Array.isArray(raw)
    ? {invariants: raw}
    : ((raw ?? {}) as Record<string, unknown>);
  const list = Array.isArray(obj.invariants) ? obj.invariants : [];
  const invariants: Invariant[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  list.forEach((entry, i) => {
    const o = (entry ?? {}) as Record<string, unknown>;
    const label = typeof o.name === 'string' ? `"${o.name}"` : `#${i}`;
    if (typeof o.name !== 'string' || o.name.trim() === '') {
      dropped.push(`${label}: no \`name\``);
      return;
    }
    if (seen.has(o.name)) {
      dropped.push(`${label}: duplicate name`);
      return;
    }
    if (typeof o.probe !== 'string' || o.probe.trim() === '') {
      dropped.push(`${label}: no \`probe\``);
      return;
    }
    if (typeof o.expect !== 'string' || !EXPECTATIONS.has(o.expect)) {
      dropped.push(
        `${label}: \`expect\` must be one of ${[...EXPECTATIONS].join(', ')}`,
      );
      return;
    }
    if (o.expect === 'bounded' && typeof o.max !== 'number') {
      dropped.push(`${label}: \`bounded\` needs a numeric \`max\``);
      return;
    }
    // A threshold given as a string would otherwise fall back to the default
    // and move the LEAK line without a word.
    const badNumber = [
      'max_per_cycle',
      'tolerance',
      'abs_tolerance',
      'max',
    ].find(
      k => o[k] != null && !(typeof o[k] === 'number' && Number.isFinite(o[k])),
    );
    if (badNumber != null) {
      dropped.push(`${label}: \`${badNumber}\` must be a number`);
      return;
    }
    seen.add(o.name);
    invariants.push({
      name: o.name,
      words: typeof o.words === 'string' ? o.words : null,
      probe: o.probe,
      visibilityProbe:
        typeof o.visibility_probe === 'string' ? o.visibility_probe : null,
      expect: o.expect as Expectation,
      maxPerCycle: num(o.max_per_cycle, 0.01),
      tolerance: num(o.tolerance, 0.05),
      absTolerance: num(o.abs_tolerance, 0),
      max: typeof o.max === 'number' ? o.max : null,
      rule: typeof o.rule === 'string' && o.rule !== '' ? o.rule : null,
    });
  });
  return {
    prelude: typeof obj.prelude === 'string' ? obj.prelude : null,
    invariants,
    source,
    dropped,
    calibration: parseCalibration(obj.calibration, dropped),
  };
}

export function loadInvariantFile(file: string): InvariantSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`could not read invariants from ${file}: ${String(e)}`);
  }
  return parseInvariantSpec(raw, file);
}

/**
 * Inline invariants win, then an explicit file, then `<run_dir>/invariants.json`,
 * then a run.json `invariants` key.
 */
export function resolveInvariantSpec(args: {
  invariants?: unknown[];
  invariants_file?: string;
  prelude?: string;
  run_dir?: string;
}): InvariantSpec {
  let spec: InvariantSpec | null = null;
  if (args.invariants != null && args.invariants.length > 0) {
    spec = parseInvariantSpec({invariants: args.invariants}, 'inline');
  } else if (args.invariants_file != null) {
    spec = loadInvariantFile(args.invariants_file);
  } else if (args.run_dir != null) {
    const dir = args.run_dir.endsWith('.json')
      ? path.dirname(args.run_dir)
      : args.run_dir;
    const beside = path.join(dir, 'invariants.json');
    if (fs.existsSync(beside)) {
      spec = loadInvariantFile(beside);
    } else {
      const runJson = path.join(dir, 'run.json');
      if (fs.existsSync(runJson)) {
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(fs.readFileSync(runJson, 'utf8')) as Record<
            string,
            unknown
          >;
        } catch (e) {
          throw new Error(
            `could not read invariants from ${runJson}: ${String(e)}`,
          );
        }
        if (raw.invariants != null) {
          spec = parseInvariantSpec(
            raw.invariants,
            `${runJson} \`invariants\``,
          );
        }
      }
    }
  }
  if (spec == null) {
    throw new Error(
      'no invariants: pass `invariants`, pass `invariants_file`, or write invariants.json into the round directory.',
    );
  }
  if (args.prelude != null) spec.prelude = args.prelude;
  if (spec.invariants.length === 0) {
    throw new Error(
      `no usable invariants in ${spec.source}${spec.dropped.length > 0 ? `: ${spec.dropped.join('; ')}` : ''}`,
    );
  }
  return spec;
}

/**
 * Does the round directory DECLARE invariants? Deliberately not "are they
 * usable": a broken invariants.json must still reach `memlab_judges`, whose
 * error then says why, rather than read as a round that declared none.
 */
export function hasInvariants(runDir: string): boolean {
  const dir = runDir.endsWith('.json') ? path.dirname(runDir) : runDir;
  if (fs.existsSync(path.join(dir, 'invariants.json'))) return true;
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, 'run.json'), 'utf8'),
    ) as Record<string, unknown>;
    return raw.invariants != null;
  } catch {
    // No readable run.json: the battery cannot plan this round at all, and
    // says so itself.
    return false;
  }
}

export interface JudgeMeasurement {
  /** Per invariant, one value per ladder rung (null = probe failed there). */
  series: Map<string, Array<number | null>>;
  settle: Map<string, number | null>;
  /** Per invariant with a visibility probe: was it ever non-zero? */
  visible: Map<string, boolean>;
  /**
   * Per invariant with a visibility probe, per ladder rung: non-zero there?
   * A slice of the round (one A/B phase) must not borrow another's visibility.
   */
  visibleAt: Map<string, boolean[]>;
  /** Same, for the settle rung. */
  visibleAtSettle: Map<string, boolean>;
  /** Per invariant, the first probe error seen. */
  errors: Map<string, string>;
}

const VIS = '\u0000vis:';

/**
 * Every judge on every rung, loading each rung once. The settle rung, when
 * given, is measured last and kept apart from the ladder series.
 */
export async function measureJudges(
  spec: InvariantSpec,
  ladder: string[],
  settlePath: string | null,
  timeoutMs: number,
  maxNodes: number,
  beforeRung?: () => void,
): Promise<JudgeMeasurement> {
  const metrics = spec.invariants.flatMap(inv => [
    {name: inv.name, code: inv.probe},
    ...(inv.visibilityProbe != null
      ? [{name: VIS + inv.name, code: inv.visibilityProbe}]
      : []),
  ]);
  const out: JudgeMeasurement = {
    series: new Map(spec.invariants.map(inv => [inv.name, []])),
    settle: new Map(),
    visible: new Map(),
    visibleAt: new Map(),
    visibleAtSettle: new Map(),
    errors: new Map(),
  };
  const rungVisible = new Map<string, boolean>();
  const record = (
    rung: Map<string, {value: number | null; error: string | null}>,
  ): Map<string, number | null> => {
    const values = new Map<string, number | null>();
    for (const inv of spec.invariants) {
      const o = rung.get(inv.name);
      values.set(inv.name, o?.value ?? null);
      if (o?.error != null && !out.errors.has(inv.name)) {
        out.errors.set(inv.name, o.error);
      }
      const vis = rung.get(VIS + inv.name);
      if (vis != null) {
        rungVisible.set(inv.name, (vis.value ?? 0) !== 0);
        out.visible.set(
          inv.name,
          (out.visible.get(inv.name) ?? false) || (vis.value ?? 0) !== 0,
        );
      }
    }
    return values;
  };
  const prelude = spec.prelude ?? undefined;
  for (const p of ladder) {
    beforeRung?.();
    const values = record(
      await probeRung(p, metrics, timeoutMs, maxNodes, prelude),
    );
    for (const inv of spec.invariants) {
      out.series.get(inv.name)?.push(values.get(inv.name) ?? null);
      if (inv.visibilityProbe != null) {
        const at = out.visibleAt.get(inv.name) ?? [];
        at.push(rungVisible.get(inv.name) ?? false);
        out.visibleAt.set(inv.name, at);
      }
    }
  }
  if (settlePath != null) {
    beforeRung?.();
    const values = record(
      await probeRung(settlePath, metrics, timeoutMs, maxNodes, prelude),
    );
    for (const inv of spec.invariants) {
      out.settle.set(inv.name, values.get(inv.name) ?? null);
      if (inv.visibilityProbe != null) {
        out.visibleAtSettle.set(inv.name, rungVisible.get(inv.name) ?? false);
      }
    }
  }
  return out;
}

/**
 * Did the visibility probe see the population on THESE rungs (and the settle
 * rung, when it is included)? Null when the invariant has no visibility probe.
 */
export function visibleOver(
  m: JudgeMeasurement,
  inv: Invariant,
  positions: number[],
  withSettle: boolean,
): boolean | null {
  if (inv.visibilityProbe == null) return null;
  const at = m.visibleAt.get(inv.name) ?? [];
  return (
    positions.some(p => at[p] === true) ||
    (withSettle && m.visibleAtSettle.get(inv.name) === true)
  );
}

export interface MeasuredRound {
  measurement: JudgeMeasurement;
  /** Cumulative cycles at each driven rung. */
  cycles: number[];
  /** Did the round capture a settle rung that is on disk? */
  settled: boolean;
}

/**
 * Every judge over one round's driven rungs and its settle rung, with the scan
 * budget re-armed per rung: it is a wall clock, and one allowance for the whole
 * ladder would starve the settle rung, which matters most.
 */
export async function measureRound(
  spec: InvariantSpec,
  runDir: string,
  opts: {timeoutMs?: number; maxNodes: number; maxFileSizeMB?: number},
): Promise<MeasuredRound> {
  const manifest = loadRunManifest(runDir);
  const settlePath =
    manifest.settleRungPath != null && snapshotExists(manifest.settleRungPath)
      ? manifest.settleRungPath
      : null;
  const {rungs, largestMB} = resolveRungs(
    [...manifest.paths, ...(settlePath != null ? [settlePath] : [])],
    opts.maxFileSizeMB,
  );
  const timeoutMs = scaledTimeoutMs(largestMB, opts.timeoutMs);
  const measurement = await measureJudges(
    spec,
    rungs.slice(0, manifest.paths.length).map(r => r.localPath),
    settlePath != null ? rungs[rungs.length - 1].localPath : null,
    timeoutMs,
    opts.maxNodes,
    () => armScanBudgetFor(timeoutMs),
  );
  return {
    measurement,
    cycles: manifest.cyclesPerRung,
    settled: settlePath != null,
  };
}

/** The verdict for one invariant over a measured round, optionally a slice of it. */
export function judgeRound(
  inv: Invariant,
  round: MeasuredRound,
  slice?: {positions: number[]; withSettle: boolean},
): JudgeOutcome {
  const m = round.measurement;
  const series = m.series.get(inv.name) ?? [];
  const positions = slice?.positions ?? series.map((_, i) => i);
  const withSettle = round.settled && (slice?.withSettle ?? true);
  return judgeSeries(
    inv,
    positions.map(p => series[p] ?? null),
    positions.map(p => round.cycles[p]),
    withSettle ? (m.settle.get(inv.name) ?? null) : null,
    visibleOver(m, inv, positions, withSettle),
    m.errors.get(inv.name) ?? null,
  );
}

/** Did the judge fire? A ladder that grew without a settle rung counts. */
export function judgeFired(o: JudgeOutcome): boolean {
  return o.fired;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(3);
}

/**
 * The verdict for one invariant from its numbers alone.
 *
 * `visible` is true or false when the invariant has a visibility probe, and
 * null when it has none.
 */
export function judgeSeries(
  inv: Invariant,
  series: Array<number | null>,
  cycles: number[],
  settle: number | null,
  visible: boolean | null,
  error: string | null = null,
): JudgeOutcome {
  // One unit for the whole axis: cycle counts when every rung has one, rung
  // indices otherwise, never a mix of the two inside one fit.
  const axis =
    cycles.length === series.length && cycles.every(Number.isFinite)
      ? cycles
      : series.map((_, i) => i);
  const pts = series.flatMap((y, i) => (y == null ? [] : [{x: axis[i], y}]));
  // A readable settle rung alone is not a judgement: with no driven rung
  // read, a `bounded` judge would PASS on the settle value and hide that the
  // whole ladder was unreadable.
  if (pts.length === 0) {
    return {
      verdict: 'ERROR',
      reason: error ?? 'the probe yielded no number on any driven rung',
      shape: null,
      slope: null,
      fired: false,
    };
  }
  const shape = pts.length >= 3 ? ladderShape(series, axis) : null;
  const after = pts.slice(1);
  const slope =
    after.length >= 2
      ? linearFit(
          after.map(p => p.x),
          after.map(p => p.y),
        ).slope
      : null;
  const first = pts.length > 0 ? pts[0].y : null;
  const last = pts.length > 0 ? pts[pts.length - 1].y : null;
  // The level after a first-mount step, so a mount that holds is not called a
  // leak and a drain back to the post-mount level counts as a drain.
  const base =
    (shape === 'STEP' || shape === 'STEP+LINEAR') && pts.length >= 2
      ? pts[1].y
      : first;
  const grew =
    slope != null &&
    slope > inv.maxPerCycle &&
    after[after.length - 1].y > after[0].y;
  const growth =
    slope != null
      ? `+${fmt(slope)}/cycle${shape != null ? `, ${shape}` : ''}`
      : '';

  let outcome: Omit<JudgeOutcome, 'fired'>;
  // Broke on the ladder, whatever the settle rung later said.
  let brokeOnLadder = false;
  switch (inv.expect) {
    case 'no-growth': {
      if (pts.length < 3) {
        outcome = {
          verdict: 'UNVERIFIED',
          unverifiedCause: 'short-ladder',
          reason:
            'fewer than 3 readable rungs, so a mount step cannot be told from growth',
          shape,
          slope,
        };
      } else if (!grew) {
        outcome = {
          verdict: 'PASS',
          reason: 'no growth past the first rung',
          shape,
          slope,
        };
      } else if (settle == null) {
        outcome = {
          verdict: 'UNSETTLED',
          reason: `grew ${growth}; no settle rung to tell backlog from a leak`,
          shape,
          slope,
        };
      } else {
        const rise = (last ?? 0) - (base ?? 0);
        const held = rise > 0 ? (settle - (base ?? 0)) / rise : 1;
        outcome =
          held <= 0.1
            ? {
                verdict: 'BACKLOG',
                reason: `grew ${growth}, then gave back ${Math.round(Math.min(1, 1 - held) * 100)}% at rest`,
                shape,
                slope,
              }
            : {
                verdict: 'LEAK',
                reason: `grew ${growth}; ${Math.round(Math.min(held, 9.99) * 100)}% of the rise still held at rest`,
                shape,
                slope,
              };
      }
      break;
    }
    case 'returns-to-baseline': {
      if (settle == null || first == null) {
        outcome = {
          verdict: 'UNSETTLED',
          reason:
            settle == null
              ? 'no settle rung, so "at rest" was never captured'
              : 'no readable baseline rung',
          shape,
          slope,
        };
        break;
      }
      const limit =
        first + Math.max(Math.abs(first) * inv.tolerance, inv.absTolerance);
      outcome =
        settle <= limit
          ? {
              verdict: 'PASS',
              reason: `at rest ${fmt(settle)} vs baseline ${fmt(first)}`,
              shape,
              slope,
            }
          : {
              verdict: 'LEAK',
              reason: `at rest ${fmt(settle)} vs baseline ${fmt(first)} (+${fmt(settle - first)}${first !== 0 ? `, +${Math.round(((settle - first) / Math.abs(first)) * 100)}%` : ''})`,
              shape,
              slope,
            };
      break;
    }
    case 'bounded': {
      const max = inv.max ?? Infinity;
      const overAt = pts.findIndex(p => p.y > max);
      brokeOnLadder = overAt >= 0;
      if (settle != null && settle > max) {
        outcome = {
          verdict: 'LEAK',
          reason: `at rest ${fmt(settle)} > max ${fmt(max)}`,
          shape,
          slope,
        };
      } else if (overAt < 0) {
        outcome = {
          verdict: 'PASS',
          reason: `every rung ≤ ${fmt(max)}`,
          shape,
          slope,
        };
      } else if (settle == null) {
        outcome = {
          verdict: 'UNSETTLED',
          reason: `rung ${overAt} reached ${fmt(pts[overAt].y)} > max ${fmt(max)}; no settle rung`,
          shape,
          slope,
        };
      } else {
        outcome = {
          verdict: 'BACKLOG',
          reason: `rung ${overAt} reached ${fmt(pts[overAt].y)} > max ${fmt(max)}, back to ${fmt(settle)} at rest`,
          shape,
          slope,
        };
      }
      break;
    }
    case 'zero-at-rest': {
      const max = inv.max ?? 0;
      outcome =
        settle == null
          ? {
              verdict: 'UNSETTLED',
              reason: 'no settle rung, so "at rest" was never captured',
              shape,
              slope,
            }
          : settle <= max
            ? {verdict: 'PASS', reason: `at rest ${fmt(settle)}`, shape, slope}
            : {
                verdict: 'LEAK',
                reason: `at rest ${fmt(settle)} > ${fmt(max)}`,
                shape,
                slope,
              };
      break;
    }
  }
  if (inv.expect === 'no-growth') brokeOnLadder = grew;
  const fired =
    outcome.verdict === 'LEAK' ||
    (outcome.verdict === 'UNSETTLED' && brokeOnLadder);
  // A judge that read 0 everywhere has not shown it can see anything, and a
  // PASS from it is the confident zero this whole approach exists to stop.
  const allZero = pts.every(p => p.y === 0) && (settle == null || settle === 0);
  if (
    outcome.verdict === 'PASS' &&
    (visible === false || (allZero && visible !== true))
  ) {
    return {
      ...outcome,
      fired: false,
      verdict: 'UNVERIFIED',
      unverifiedCause: 'not-visible',
      reason:
        visible === false
          ? 'the visibility probe was 0 on every rung, so this probe family sees nothing here'
          : '0 at every rung and no visibility probe showed the population is visible',
    };
  }
  return {...outcome, fired};
}
