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
import fs from 'fs';
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

/**
 * How a probe reaches its population, as a set of access MECHANISMS.
 *
 * A visibility control is only a control if it exercises the same mechanism as
 * the probe it is vouching for. `helpers.byClass('Object').length` — the
 * default — proves the snapshot parses and that class lookup works. It proves
 * nothing at all about a `withProp` probe, and the verdict text nevertheless
 * said "verified negative rather than a blind one".
 *
 * Textual, and honest about it: this reads the source of the expression, not
 * what it does. That is enough to catch the mismatch that matters, which is a
 * control written with a different helper family.
 */
export const ACCESS_MECHANISMS: ReadonlyArray<{
  id: string;
  label: string;
  pattern: RegExp;
}> = [
  {
    id: 'edge-name',
    label: 'edge-name lookup (withProp / byEdgeName / edgeTarget / derefPath)',
    pattern:
      /\b(withProp|byEdgeName|edgeTarget|derefPath|findWithin|getProp)\s*\(/,
  },
  {
    id: 'shape',
    label: 'shape matching (hasShape / byShape / shapeKeys / ownProps)',
    pattern: /\b(hasShape|byShape|shapeKeys|ownProps|shapeSignature)\s*\(/,
  },
  {
    id: 'class',
    label: 'class-name lookup (byClass / nodesByClass / iterByClass)',
    pattern: /\b(byClass|nodesByClass|iterByClass|classCounts|byTypename)\s*\(/,
  },
  {
    id: 'context',
    label: 'closure capture (byContextSlot / byContextVar / contextOf)',
    pattern:
      /\b(byContextSlot|byContextVar|contextOf|contextSlotCensus|closureCensus)\s*\(/,
  },
  {
    id: 'container',
    label: 'container enumeration (entries / mapEntries / setElements)',
    // Anchored to a RECEIVER. Bare `entries(` also matches `Object.entries(`,
    // which is ordinary JavaScript and not a heap-access mechanism at all —
    // and a control containing one would then "share" this mechanism with an
    // unrelated probe and turn a real other-path mismatch into a false
    // `verified-same-path`, defeating the fix this file exists for.
    pattern: /\.(entries|mapEntries|setElements|elements)\s*\(/,
  },
  {
    id: 'referrer',
    label: 'referrer walk (byReferrerEdge / groupReferrersByEdge / referrers)',
    pattern: /\b(byReferrerEdge|groupReferrersByEdge)\s*\(|\.referrers\b/,
  },
  {
    id: 'detached',
    label: 'detached-DOM matching (detachedNamed / isRealDetached)',
    pattern: /\b(detachedNamed|isRealDetached)\s*\(/,
  },
  {
    id: 'listener',
    label: 'listener records (listenerRecords)',
    pattern: /\blistenerRecords\s*\(/,
  },
  {
    id: 'raw-walk',
    label: 'raw graph walk (snapshot.nodes / .references)',
    pattern:
      /\bsnapshot\s*\.\s*(nodes|edges)\b|\.references\b|\bhelpers\.walk\s*\(/,
  },
];

export function accessMechanisms(code: string): Set<string> {
  const out = new Set<string>();
  for (const m of ACCESS_MECHANISMS) if (m.pattern.test(code)) out.add(m.id);
  return out;
}

export function describeMechanisms(ids: ReadonlySet<string>): string {
  if (ids.size === 0) return 'no recognised helper';
  return ACCESS_MECHANISMS.filter(m => ids.has(m.id))
    .map(m => m.label)
    .join(', ');
}

/**
 * What the visibility control established about ONE metric.
 *
 * `verified-other-path` is the case this type exists for: the control returned
 * a number, so the heap is readable, but it reached it a different way — so it
 * says nothing about whether THIS probe can see its population.
 */
export type VisibilityStatus =
  | 'blind'
  | 'verified-same-path'
  | 'verified-other-path'
  /**
   * The probe uses no helper this file knows how to classify — one added
   * since, or a name built at runtime. Distinct from `verified-other-path`,
   * which asserts a MISMATCH: claiming one from a failure to classify is the
   * same false confidence, pointing the other way, as the bug this status
   * type exists to fix.
   */
  | 'unclassified';

export function verdictFor(
  values: number[],
  fit: LinearFit,
  axisAssumed = false,
  visibility: VisibilityStatus = 'blind',
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
    if (max === 0 && visibility === 'blind') {
      return (
        'UNKNOWN — 0 at every rung, and the visibility control ALSO returned ' +
        '0, so this heap did not answer either probe. That is the signature of ' +
        'a snapshot the probes cannot read (a light load, a truncated capture), ' +
        'not of a clean population. Do NOT record this as a negative result.'
      );
    }
    // "verified negative" is the strongest claim this tool makes, and it is
    // only earned by a control that reached its number the SAME way `code`
    // does. A control on a different access path proves the snapshot is
    // readable and nothing else — which is exactly the state in which a
    // property-only probe reported 0 at every rung against a true series of
    // 0 / 253 / 492 / 718 / 751 and was certified.
    if (max === 0 && visibility === 'unclassified') {
      return (
        'FLAT (UNVERIFIED — the probe could not be classified) — 0 at every ' +
        'rung. The control returned a number, so the snapshot is readable, ' +
        'but this probe uses no helper whose access path is recognised, so ' +
        'there is no way to tell whether the control exercised the same one. ' +
        'Write the probe with a named helper (`byClass`, `withProp`, ' +
        '`byShape`, `byContextVar`, …), or pass a `visibility_probe` that is ' +
        'literally the same expression with a name known to be present.'
      );
    }
    if (max === 0 && visibility === 'verified-other-path') {
      return (
        'FLAT (UNVERIFIED — the control uses a DIFFERENT access path) — 0 at ' +
        'every rung. The visibility control did return a number, so the ' +
        'snapshot is readable, but it reached it by a different mechanism than ' +
        '`code` does, so it says nothing about whether THIS probe can see its ' +
        'population. A probe that cannot reach its population returns exactly ' +
        'these zeros. Pass a `visibility_probe` written with the SAME helpers ' +
        'as `code` before recording a negative — see the access-path note above.'
      );
    }
    return max === 0
      ? 'FLAT — 0 at every rung, and a visibility control on the SAME access ' +
          'path returned a non-zero value on this ladder, so this is a ' +
          'verified negative rather than a blind one'
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

/**
 * The string literals a probe matches edge NAMES against.
 *
 * Only the helpers that take a name are read, and only literal arguments — a
 * name built at runtime cannot be recovered from source, and guessing would
 * produce a diagnostic about a name the probe never asked for.
 */
export function extractProbedNames(code: string): string[] {
  const out = new Set<string>();
  const add = (s: string): void => {
    // A backslash means the naive quote capture stopped somewhere other
    // than the real end of the literal — `'a\\'b'` yields `a\\`. Re-probing
    // for that truncated name finds nothing and the series reads as a
    // verified absence of a name the probe never looked for. Dropping the
    // candidate costs a re-probe and never a wrong certification.
    if (s.length > 0 && s.length <= 80 && !s.includes('\\')) out.add(s);
  };
  const str = `(?:'([^']*)'|"([^"]*)")`;
  // withProp('x') / byEdgeName('x') / byContextSlot('x') / byTypename('x') …
  const single = new RegExp(
    `\\b(?:withProp|byEdgeName|byContextSlot|byContextVar|byReferrerEdge)\\s*\\(\\s*${str}`,
    'g',
  );
  // edgeTarget(id, 'x') / getProp(id, 'x') / findWithin(id, 'x')
  const second = new RegExp(
    `\\b(?:edgeTarget|getProp|findWithin|walkChain)\\s*\\([^,()]*,\\s*${str}`,
    'g',
  );
  // hasShape(id, ['a','b']) / byShape(['a','b'])
  const arrays = /\b(?:hasShape|byShape)\s*\([^[]*\[([^\]]*)\]/g;
  for (const re of [single, second]) {
    let m;
    while ((m = re.exec(code)) != null) add(m[1] ?? m[2] ?? '');
  }
  let m;
  while ((m = arrays.exec(code)) != null) {
    for (const lit of m[1].matchAll(/'([^']*)'|"([^"]*)"/g)) {
      add(lit[1] ?? lit[2] ?? '');
    }
  }
  return [...out];
}

/**
 * Source for the relaxed re-probe: for each candidate NAME, how many holders
 * carry an edge of that name, broken down by edge TYPE.
 *
 * One full pass for every name at once. The point is to answer "is the
 * population there at all, reached some other way?" — the single question an
 * all-zero series cannot answer about itself.
 */
/**
 * `complete: true` is assigned only after the node walk RETURNS. A scan cut
 * short by the node budget throws out of `forEach`, so that line never runs
 * and `parseAutoVisibility` rejects the result — "the name is absent" and "we
 * stopped looking" must not render the same, because this probe's answer is
 * what certifies a flat zero as a real absence.
 */
export function autoVisibilityCode(names: readonly string[]): string {
  return `
const WANT = new Set(${JSON.stringify(names)});
const counts = {};
let skipped = 0;
snapshot.nodes.forEach(node => {
  if (node.id <= 3) return;
  let refs;
  try { refs = node.references; } catch (e) { return; }
  const seen = new Set();
  for (const e of refs) {
    let name, type;
    try { name = String(e.name_or_index); type = e.type; } catch (x) { continue; }
    if (!WANT.has(name)) continue;
    const k = name + '\\u0000' + type;
    if (seen.has(k)) continue;
    seen.add(k);
    counts[name] = counts[name] || {};
    counts[name][type] = (counts[name][type] || 0) + 1;
  }
});
if (typeof snapshot.__skippedEdges === 'object' && snapshot.__skippedEdges != null) {
  skipped = snapshot.__skippedEdges.total_reads || 0;
}
result = {counts, complete: true, skipped_edge_reads: skipped};`.trim();
}

/** Run one expression against one rung and hand back its raw text. */
async function evalOnRung(
  localPath: string,
  code: string,
  timeoutMs: number,
  maxNodes: number,
): Promise<string> {
  let text = '';
  await withSnapshotAt(localPath, async () => {
    text = textOf(
      await runEval({
        mode: 'eval',
        code,
        timeout_ms: timeoutMs,
        max_nodes: maxNodes,
      }),
    );
  });
  return text;
}

/** Pull the `{name: {edgeType: count}}` object back out of eval's text. */
export function parseAutoVisibility(
  text: string,
): Record<string, Record<string, number>> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  // The SHAPE is checked, not just "is an object". This function's answer is
  // what certifies a zero as a real absence, and the text it reads is a whole
  // tool result — a footer, a wrapper, an error object, anything with braces
  // parses. A wrong shape read as an empty count table certifies the absence
  // of a name nothing ever looked for.
  if (parsed == null || typeof parsed !== 'object') return null;
  const envelope = parsed as Record<string, unknown>;
  if (envelope.complete !== true) return null;
  const counts = envelope.counts;
  if (counts == null || typeof counts !== 'object') return null;
  const out: Record<string, Record<string, number>> = {};
  for (const [name, byType] of Object.entries(
    counts as Record<string, unknown>,
  )) {
    if (byType == null || typeof byType !== 'object') return null;
    const inner: Record<string, number> = {};
    for (const [type, n] of Object.entries(byType as Record<string, unknown>)) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return null;
      inner[type] = n;
    }
    out[name] = inner;
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
          'A CONTROL expression, evaluated on every rung exactly like `code`, whose value MUST be non-zero on a healthy heap. Its only job is to answer "can a probe of this kind see anything here?". IT MUST USE THE SAME HELPERS AS `code`: a control written with different helpers proves only that the snapshot is readable, and an all-zero series is then reported as FLAT (UNVERIFIED) rather than as a verified negative. Without it a default class-lookup control is used, which is almost never the same access path. Supply it whenever a zero result would be recorded as "no leak here".',
        ),
      include_settle: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "In `run_dir` mode, append the round's settle rung (`rung_99_settle`) to the ladder, measure every metric on it too, and report an `after settle` line per metric with a drained/held verdict. It is EXCLUDED from the rate and the shape verdict automatically — the settle drives no cycles, so it sits at the last driven rung's cycle count. This is the measurement that separates in-flight backlog from retention; without it a burst of promise chains, scheduler queues and request buffers reads as a linear leak.",
        ),
      auto_visibility: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'On an all-zero series, re-probe the LAST rung for the edge NAMES `code` matches on, counting holders by edge TYPE, and report any name that is present in the heap by a route the probe does not index (a `context` edge for a closure-captured variable, an `internal` edge for a backing slot). This is what turns "0 everywhere" into "present, but you looked for it as a property". Costs one extra load of the last rung, and only fires when a reported metric is zero at every rung.',
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
      include_settle,
      auto_visibility,
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
        // Append the settle rung, when the round captured one and it is not
        // already in the ladder.
        //
        // Measuring a population across the driven rungs AND after idle used
        // to mean listing `paths` by hand and inventing a cycle number for the
        // settle rung — one operator wrote `[0,175,350,475,476]`, because a
        // rung sharing a cycle count is dropped from the fit. That is a hack,
        // and it was done five times in one sweep. The settle rung belongs at
        // the cycle count of the last DRIVEN rung (it drives nothing), which
        // is exactly the duplicate-x case the fit already excludes — so the
        // value is measured and reported without ever entering the rate.
        let settleAppended = false;
        // The manifest named a settle rung that is not on disk. Distinct from
        // "captured none": the round was DRIVEN with one, and the file went
        // missing after — pruned, or the capture was interrupted. Reporting
        // that as "re-drive with --settle-minutes 7" sends the reader to
        // re-run a round they already have.
        let settleMissingPath: string | null = null;
        // Which rung is the settle one, so the axis can give it the cycle
        // count of the last DRIVEN rung. The duplicate x is the whole
        // mechanism keeping it out of the fit, and it has to hold on EVERY
        // axis: a scalar `cycles` spreads the rungs evenly over the rung
        // COUNT, and with no cycle information the axis is the rung index —
        // on both, an appended rung silently gets an x of its own and
        // flattens the rate it was added to sit outside of.
        let settleIndex: number | null = null;
        if (
          include_settle !== false &&
          inputs.manifest?.settleRungPath != null &&
          !resolved.some(p => p === inputs.manifest?.settleRungPath)
        ) {
          const settlePath = inputs.manifest.settleRungPath;
          if (fs.existsSync(settlePath)) {
            resolved.push(settlePath);
            if (cycles_per_rung != null) {
              cycles_per_rung = [
                ...cycles_per_rung,
                cycles_per_rung[cycles_per_rung.length - 1],
              ];
            }
            settleIndex = resolved.length - 1;
            settleAppended = true;
          } else {
            settleMissingPath = settlePath;
          }
        }
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

        const xsFor = (n: number): number[] => {
          // The settle rung is not a driven rung, so it is not one of the n
          // the even spread divides between.
          const driven = settleIndex != null ? n - 1 : n;
          return Array.from({length: n}, (_, i) => {
            const at = i === settleIndex ? i - 1 : i;
            if (cycles_per_rung != null) return cycles_per_rung[at];
            if (cyclesResolved != null)
              return (cyclesResolved * at) / Math.max(1, driven - 1);
            return at;
          });
        };
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
        // Same-path is decided per REPORTED metric, because `metrics` can hold
        // probes written with different helper families and one control cannot
        // vouch for all of them.
        const controlMechanisms = accessMechanisms(visibilityCode);
        const visibilityFor = (probeCode: string): VisibilityStatus => {
          if (!visibilityVerified) return 'blind';
          const mine = accessMechanisms(probeCode);
          // Nothing recognised is not a mismatch; it is an unknown. Falling
          // through the empty loop to 'verified-other-path' asserts the
          // control took a DIFFERENT path, which is the same false confidence
          // this status type exists to remove, pointing the other way.
          if (mine.size === 0) return 'unclassified';
          // EVERY mechanism, not any one. A probe that reaches its real
          // population through `byContextVar` while incidentally calling
          // `byClass` shares the second with almost any control, and one
          // shared mechanism was enough to certify the whole probe — so the
          // path that actually produced the zero went unchecked. The failure
          // this direction is a spurious "paths differ" warning; the other
          // direction is a zero published as a verified negative.
          for (const id of mine) {
            if (!controlMechanisms.has(id)) return 'verified-other-path';
          }
          return 'verified-same-path';
        };

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
        // Names worth re-probing: those belonging to a metric that read 0 at
        // every rung. Collected here, resolved once after the loop.
        const zeroSeriesNames = new Set<string>();
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
          // Whether the exclusion actually applied. It only does at a SHARED
          // x, and a settle rung listed by hand in `paths` never gets one —
          // the append guard sees it already present, so no duplicate is
          // created and it is fitted as though it drove cycles. Claiming the
          // exclusion regardless is how a rate contaminated by a GC'd reading
          // gets published as clean.
          const settleUsableIdx = usableIsSettle.findIndex(Boolean);
          const settleInFit = settleUsableIdx >= 0 && distinct[settleUsableIdx];
          // Where the settle reading landed inside `fitYs`, when it was not
          // deduped out. `fitYs` is `usableYs` filtered by `distinct`, so
          // the position is the number of kept entries before it.
          const settleFitIdx = settleInFit
            ? distinct.slice(0, settleUsableIdx).filter(Boolean).length
            : -1;
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
          // The settle reading, pulled out of the series so the verdict can be
          // stated rather than inferred from a repeated row.
          const settleRow = rungs.find(
            r => isSettleRungFilename(r.label) && r.value != null,
          );
          const shapeYs = fitYs;
          const status = visibilityFor(m.code);
          const verdictText = singleX
            ? 'UNMEASURABLE AXIS — every rung shares one cycle count, so the series has no shape to read. The values above are real; the trend is not derivable from them.'
            : verdictFor(shapeYs, fit, axisAssumed, status);
          lines.push(`**Verdict:** ${verdictText}`);
          // `fitYs.length > 0` is not decoration: the fit series is the
          // deduped driven rungs, and a ladder whose every rung failed to
          // measure leaves it empty. `base` is then undefined, `grew` is NaN,
          // and the row renders "(NaN% of the growth held)" beside a
          // confident DRAINED or HELD word.
          if (settleRow != null && fitYs.length > 0) {
            const idle = settleRow.value as number;
            // DRIVEN rungs only. When the settle rung was hand-listed in
            // `paths` at a cycle count of its own it is not deduped out, so
            // it sits inside `fitYs` — and scoring the settle value against
            // a series that already contains it compares the reading to
            // itself. `grew` collapses toward zero and the row reports HELD
            // on arithmetic that has nothing to do with retention.
            const drivenYs =
              settleFitIdx >= 0
                ? fitYs.filter((_, fi) => fi !== settleFitIdx)
                : fitYs;
            const base = drivenYs.length > 0 ? drivenYs[0] : fitYs[0];
            const lastDriven =
              drivenYs.length > 0 ? drivenYs[drivenYs.length - 1] : last;
            const grew = lastDriven - base;
            // Scored against the GROWTH, not the total: a population with a
            // large standing baseline that was never part of the burst would
            // otherwise always read as held.
            // Clamped to [0, 1]. Unclamped, a settle reading below the
            // starting baseline renders "-33% of the growth held", which is
            // not a fraction of anything — the class released all of its
            // growth and then some, and 0% is what that is.
            // `grew <= 0` is NOT "fully held". A non-monotonic series whose
            // last driven rung sits at or below the first has no growth to
            // hold a fraction of, and forcing 1 there printed a confident
            // "100% of the growth held" over a series that never grew —
            // and suppressed both other verdicts while doing it.
            const kept =
              grew > 0 ? Math.max(0, Math.min(1, (idle - base) / grew)) : null;
            const drained = kept != null && kept <= 0.1;
            // Above the last DRIVEN value. Nothing "held" more than all of
            // the growth, so a fraction over 1 is not a held fraction at
            // all — it is the population still climbing while the settle
            // rung was captured, and "142% of the growth held" reads as a
            // mis-rendered percentage rather than as the finding it is.
            const stillClimbing = grew > 0 && idle > lastDriven;
            // Above the baseline with no net growth to explain it: the
            // series went up and came back down, and the settle rung still
            // sits higher than where it started.
            const aboveBaseNoGrowth = grew <= 0 && idle > base;
            lines.push(
              '',
              `**After settle: ${formatNumber(idle)}** (${
                stillClimbing
                  ? 'HIGHER than the last driven rung — the population was still climbing when the settle rung was captured'
                  : kept != null
                    ? `${(kept * 100).toFixed(0)}% of the growth held`
                    : aboveBaseNoGrowth
                      ? `no net growth across the driven rungs, yet the settle rung sits above the first (${formatNumber(base)})`
                      : 'nothing grew, so there is nothing to drain'
              }) — ${
                drained
                  ? '💧 **DRAINED. This is in-flight backlog, not retention** — the rate above is real and is not a leak. Do not file it.'
                  : stillClimbing
                    ? '**HELD, and then some.** Nothing was released during the settle; the idle period was not long enough to see this one level off, so treat the rate above as a lower bound.'
                    : kept != null
                      ? '**HELD.** The growth survived idle + GC, so it is retention rather than work in flight.'
                      : aboveBaseNoGrowth
                        ? 'NO VERDICT — the driven series is non-monotonic, so there is no growth to score this against. Read the per-rung values above directly.'
                        : 'no verdict available.'
              }${
                settleInFit
                  ? " ⚠️ **NOT excluded from the rate above**: this rung was listed in `paths` at a cycle count of its own, so the fit treated it as a driven rung. Remove it from `paths` and let `include_settle` append it, or give it the last driven rung's count in `cycles_per_rung`."
                  : ' Excluded from the rate and the shape verdict: the settle drives no cycles.'
              }`,
            );
          } else if (settleMissingPath != null) {
            lines.push(
              '',
              `> ⚠️ **UNSETTLED — the settle rung is missing from disk.** The round records one at \`${settleMissingPath}\`, but the file is not there (pruned, or the capture was interrupted). The rate above cannot be told apart from in-flight backlog. The round does not need re-driving if the file can be restored.`,
            );
          } else if (
            include_settle !== false &&
            inputs.manifest != null &&
            !settleAppended
          ) {
            lines.push(
              '',
              '> ⚠️ **UNSETTLED** — this round captured no settle rung, so the rate above cannot be told apart from in-flight backlog. Re-drive with the runner default (`--settle-minutes 7`).',
            );
          }
          // `every`, not `Math.max(...) === 0`. Spreading an empty array
          // into Math.max gives -Infinity, which is not 0, so a metric that
          // failed to measure at EVERY rung skipped the re-probe that exists
          // to tell a real absence from an unobservable one.
          const allZero = headerYs.length > 0 && headerYs.every(y => y === 0);
          if (allZero) {
            for (const n of extractProbedNames(m.code)) zeroSeriesNames.add(n);
          }
          if (allZero && status === 'unclassified') {
            lines.push(
              '',
              '> **Access path unclassified.** The control returned a number, ' +
                'so the snapshot is readable, but `code` reaches its ' +
                'population through no helper this server recognises, so ' +
                'there is no way to tell whether the control exercised the ' +
                'same one. Rewrite the probe around a named helper, or pass ' +
                'a `visibility_probe` that differs from it only in the name ' +
                'it looks for.',
            );
          }
          if (allZero && status === 'verified-other-path') {
            lines.push(
              '',
              `> **Access paths differ.** \`code\` reaches its population by ${describeMechanisms(
                accessMechanisms(m.code),
              )}; the control used ${describeMechanisms(controlMechanisms)}${
                callerVisibilityProbe
                  ? ''
                  : ' (the DEFAULT control — you did not pass `visibility_probe`)'
              }.`,
            );
          }
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

        // An all-zero series cannot tell "absent" from "unreachable by this
        // probe" on its own. Ask the heap directly: for every name the probe
        // matched on, how many holders carry an edge of that name, by edge
        // TYPE? A non-zero total is proof the population is there and the
        // probe was looking down the wrong kind of edge.
        if (auto_visibility !== false && zeroSeriesNames.size > 0) {
          const names = [...zeroSeriesNames];
          const last = locals[locals.length - 1];
          armScanBudgetFor(effectiveTimeout);
          let found: Record<string, Record<string, number>> | null = null;
          let reprobeError: string | null = null;
          try {
            found = parseAutoVisibility(
              await evalOnRung(
                last.localPath,
                autoVisibilityCode(names),
                effectiveTimeout,
                max_nodes,
              ),
            );
          } catch (e) {
            reprobeError = e instanceof Error ? e.message : String(e);
          }
          lines.push('### Auto-visibility re-probe (all-zero series)');
          lines.push('');
          if (reprobeError != null) {
            lines.push(
              `_Could not re-probe \`${last.label}\`: ${reprobeError}_`,
              '',
            );
          } else if (found == null) {
            // `parseAutoVisibility` returns null WITHOUT throwing when the
            // eval produced nothing parseable, so `reprobeError` is null and
            // the absence branch below would positively certify "the zero is
            // a real absence" on the strength of a parse failure. That is the
            // same false negative this whole feature exists to prevent.
            lines.push(
              `_The re-probe of \`${last.label}\` returned no parseable result, so reachability is UNDETERMINED — this is not evidence of absence. Re-run with \`auto_visibility: false\` and probe the names by hand._`,
              '',
            );
          } else {
            const present = names.filter(
              n => Object.keys(found?.[n] ?? {}).length > 0,
            );
            if (present.length === 0) {
              lines.push(
                `No holder in \`${last.label}\` carries an edge named ${names
                  .map(n => `\`${n}\``)
                  .join(
                    ', ',
                  )} — by ANY edge type. The zero is a real absence, ` +
                  'not a wrong access path. (This does not rule out a name built ' +
                  'at runtime, which cannot be read out of the source.)',
                '',
              );
            } else {
              lines.push(
                '⚠️ **The name IS in this heap.** The probe read 0 at every rung, ' +
                  'but these holders carry an edge with that name:',
                '',
              );
              lines.push(
                markdownTable(
                  ['Name', 'Edge type', 'Holders'],
                  present.flatMap(n =>
                    Object.entries(found?.[n] ?? {})
                      .sort((a, b) => b[1] - a[1])
                      .map(([type, count]) => [
                        `\`${n}\``,
                        `\`${type}\``,
                        formatNumber(count),
                      ]),
                  ),
                ),
              );
              lines.push(
                '',
                'A `context` edge is a CLOSURE-CAPTURED variable — it is not a property ' +
                  'of anything, so property or shape matching cannot see it; use ' +
                  '`helpers.byContextVar(name)` or `helpers.withProp(name, {edgeTypes:["context"]})`. ' +
                  'An `internal` / `hidden` edge is an engine backing slot (a Map `table`, ' +
                  'an array `elements`) — reach it with `helpers.entries()` / ' +
                  '`helpers.edgeTarget()`. `helpers.byEdgeName(name)` ignores edge type ' +
                  'entirely and is the widest re-probe.',
                '',
                `_Measured on the last rung (\`${last.label}\`) only — this establishes reachability, not a rate. Re-run the probe on the right access path to get the series._`,
                '',
              );
            }
          }
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
