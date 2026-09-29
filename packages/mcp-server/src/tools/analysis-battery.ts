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
 * Run a round's whole analysis in one call, write the detail to disk, and
 * return only a digest.
 *
 * `memlab_batch` already runs several tools in one session, which is the half
 * that saves wall clock — the snapshot load dominates, so N tools over one
 * resident graph costs about what one does. But it returns every result INLINE,
 * and that is the half that makes a sweep impossible: a standard round's worth
 * of tools is tens of thousands of tokens of prose, and twenty rounds of it does
 * not fit in any context window.
 *
 * A session that ran a twenty-round sweep hand-rolled this — a JSONL of ~35 tool
 * calls piped through the CLI, stdout split on the per-tool banner into
 * per-tool files, plus a shell script to grep fifteen headline lines back out.
 * That script was the difference between the sweep being feasible and not, and
 * it lived in /tmp and died with the host. This is that, as a tool.
 *
 * The digest is deliberately small and fixed: audit verdict, app-vs-artifact
 * split, the top growers with rate and fit, census totals, the named
 * collections over a size threshold. Everything else is a file path. The point
 * is that a round costs a bounded number of tokens to READ, and the detail is
 * still there when a specific question needs it.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {z} from 'zod';
import {loadRunManifest} from '../run-manifest.js';
import {getRegisteredTool} from '../tool-registry.js';
import {makeProgressReporter} from '../progress.js';
import {snapshotExists} from '../snapshot-index.js';
import {errorResult, formatBytes, formatNumber, toolResult} from '../utils.js';

/**
 * A battery started with `async: true`, tracked so `memlab_battery_status` can
 * report on it.
 *
 * Why this exists: the standard battery runs 7-10 minutes and EVERY call of it
 * in one 20-round sweep exceeded the generic 120 s tool timeout and was
 * backgrounded. Backgrounding works, but each one then costs a polling turn
 * and the notification arrives interleaved with unrelated work — over a sweep
 * that was the single largest avoidable overhead. Returning a handle
 * immediately makes the wait explicit and pollable instead.
 */
interface BatteryRun {
  id: string;
  runDir: string;
  profile: string;
  outDir: string;
  startedAt: number;
  finishedAt: number | null;
  totalSteps: number;
  doneSteps: number;
  currentTool: string | null;
  result: string | null;
  error: string | null;
}

const batteries = new Map<string, BatteryRun>();
let batterySeq = 0;

/**
 * Finished runs are kept so a status poll that arrives after completion gets
 * the RESULT rather than "unknown id" — which is the common case, since the
 * point of the handle is to come back later. Bounded so a long session does
 * not accumulate every battery it ever ran.
 */
const MAX_TRACKED_BATTERIES = 20;

/**
 * Handles dropped to hold the bound, id -> output directory.
 *
 * Kept so `memlab_battery_status` can tell "this ran and its handle was
 * evicted, the files are here" from "this id was never in this process".
 */
const evicted = new Map<string, BatteryRun>();

/**
 * Output directories currently claimed by a running battery, resolved path
 * -> battery id. Held for sync and async runs alike, and independent of
 * `batteries`, so an evicted handle still blocks a second writer.
 */
const activeOutDirs = new Map<string, string>();

/**
 * How long a battery may hold its output directory before the claim is
 * released anyway. Far longer than a real battery (7-10 minutes), because
 * this exists only to stop a wedged run blocking the directory forever.
 */
const RESERVATION_MAX_MS = 60 * 60 * 1000;

function trackBattery(run: BatteryRun): void {
  batteries.set(run.id, run);
  if (batteries.size <= MAX_TRACKED_BATTERIES) return;
  // Finished runs first, oldest out: their report has been sitting there to
  // be collected and the newest is the one most likely still wanted.
  const finished = [...batteries.values()]
    .filter(b => b.finishedAt != null)
    .sort((a, b) => (a.finishedAt as number) - (b.finishedAt as number));
  while (batteries.size > MAX_TRACKED_BATTERIES && finished.length > 0) {
    batteries.delete((finished.shift() as BatteryRun).id);
  }
  // Then RUNNING ones, oldest-started first. Evicting only finished runs
  // made the bound conditional on something outside this function: start 21
  // batteries that are all still going and the map grows without limit,
  // which is exactly what the docstring above promises it will not do. A
  // running battery that is evicted keeps running and still writes its
  // per-tool files; only the pollable handle is dropped, and the oldest one
  // is the handle least likely to still be polled.
  if (batteries.size <= MAX_TRACKED_BATTERIES) return;
  const running = [...batteries.values()]
    .filter(b => b.finishedAt == null && b.id !== run.id)
    .sort((a, b) => a.startedAt - b.startedAt);
  while (batteries.size > MAX_TRACKED_BATTERIES && running.length > 0) {
    const victim = running.shift() as BatteryRun;
    batteries.delete(victim.id);
    // REMEMBERED, not just dropped. The detached run keeps going and
    // writes its per-tool files, but its handle is gone — and a later
    // status poll then took the "not in this process" branch and blamed a
    // server restart that never happened, while the report was sitting
    // unreachable in memory. An id and an out dir is all it takes to say
    // what actually became of it.
    evicted.set(victim.id, victim);
    while (evicted.size > MAX_TRACKED_BATTERIES * 2) {
      const first = evicted.keys().next();
      if (first.done === true) break;
      evicted.delete(first.value);
    }
  }
}

/** One step of a battery: a tool and the args it gets. */
interface Step {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * The tool sets, ordered so the cheap ladder-level passes (which load rungs
 * transiently, one at a time) run before the single-snapshot deep dive (which
 * holds the final rung resident).
 *
 * Taken from the battery a real sweep converged on rather than from the tool
 * list — these are the calls that actually got read.
 */
function buildPlan(
  profile: string,
  runDir: string,
  paths: string[],
  cycles: number,
  finalRung: string,
  baseRung: string,
  hasSettleRung: boolean,
): Step[] {
  const ladder: Step[] = [
    // FIRST, deliberately. On one app 59-75% of the heap is not the
    // application at all, and `app_delta` ran between 7% and 86% of the
    // post-GC total depending on the round — so every other number in the
    // battery is read against it, and reading them first means reading them
    // without it. It was also the most under-used tool in the set.
    {
      tool: 'memlab_artifact_budget',
      args: {target: finalRung, baseline: baseRung},
    },
    {tool: 'memlab_round_audit', args: {run_dir: runDir}},
    {tool: 'memlab_leak_report', args: {run_dir: runDir, limit: 14}},
    // In the STANDARD profile, not an optional extra. The runner captures a
    // settle rung by default and the entire backlog-vs-retention distinction
    // rests on it, yet the battery left it out — so a round's leak list was
    // whatever grew, settled or not. Measured across one 20-round sweep, the
    // rounds where it was called by hand had their verdict changed EVERY
    // time: 92,452 objects and 26.3 MB that the ladder called leaks were
    // retired by idle + GC. Skipped, rather than failing, when the round has
    // no settle rung.
    ...(hasSettleRung
      ? [{tool: 'memlab_settle_check', args: {run_dir: runDir}}]
      : []),
    {
      tool: 'memlab_census_diff',
      args: {baseline: baseRung, target: finalRung, top_n: 30},
    },
  ];

  const deep: Step[] = [
    {
      tool: 'memlab_load_snapshot',
      args: {file_path: finalRung, quiet: true, suppress_suggestions: true},
    },
    {tool: 'memlab_app_heap', args: {}},
    {tool: 'memlab_dev_artifacts', args: {}},
    {tool: 'memlab_cache_analysis', args: {}},
    {tool: 'memlab_stale_collections', args: {}},
    {tool: 'memlab_growth_signals', args: {}},
    {tool: 'memlab_detached_dom', args: {group_by: 'dominator'}},
    {tool: 'memlab_event_listener_leaks', args: {}},
    // Given the ladder rather than one rung, this returns the breadth-vs-length
    // verdict instead of a census. Without it the battery prints a table of
    // queue counts from which the one question the tool exists to answer —
    // are chains LENGTHENING or are there just more hooks — cannot be read.
    {tool: 'memlab_react_update_queues', args: {run_dir: runDir}},
    {tool: 'memlab_async_census', args: {}},
    {tool: 'memlab_retention_windows', args: {}},
  ];

  const optimization: Step[] = [
    {tool: 'memlab_duplicated_strings', args: {}},
    {tool: 'memlab_intern_opportunities', args: {}},
    {tool: 'memlab_duplicate_objects', args: {}},
    {tool: 'memlab_shape_histogram', args: {}},
    {tool: 'memlab_sparse_elements', args: {}},
    {tool: 'memlab_script_census', args: {}},
    {tool: 'memlab_largest_objects', args: {}},
  ];

  const extra: Step[] = [
    {tool: 'memlab_sequence_analysis', args: {run_dir: runDir}},
    {tool: 'memlab_auto_investigate', args: {}},
    {tool: 'memlab_quick_diagnosis', args: {}},
    {tool: 'memlab_pinch_points', args: {}},
    {tool: 'memlab_event_registry', args: {}},
    {tool: 'memlab_weakref_census', args: {}},
    {tool: 'memlab_global_variables', args: {}},
    {tool: 'memlab_react_owners', args: {}},
    {tool: 'memlab_dom_audit', args: {}},
    {tool: 'memlab_id_space_audit', args: {}},
    {tool: 'memlab_class_histogram', args: {limit: 40}},
    {tool: 'memlab_next_measurement', args: {}},
  ];

  if (profile === 'optimization') return [...ladder, ...deep, ...optimization];
  if (profile === 'deep') {
    return [...ladder, ...deep, ...optimization, ...extra];
  }
  return [...ladder, ...deep];
}

/** Lines worth lifting into the digest, per tool. */
const DIGEST_PATTERNS: ReadonlyArray<{tool: RegExp; re: RegExp; max: number}> =
  [
    {tool: /round_audit/, re: /^\*\*Verdict:.*$|^\| [⚠✅❌]/, max: 10},
    {
      tool: /artifact_budget/,
      re: /not the application|^\*\*app_delta|^\| (App|TOTAL) /,
      max: 5,
    },
    {
      tool: /leak_report/,
      re: /^\*\*Settle: |^> ⚠️ \*\*UNSETTLED|^\| [A-Za-z(]/,
      max: 10,
    },
    // The headline, not the table: "N HELD / M DRAINED" is the one line that
    // tells a reader whether the round's leak list means anything.
    {
      tool: /settle_check/,
      re: /^\*\*\d+ class\(es\) survived|^\*\*Everything that grew came back|^\*\*No baseline given|^No settle rung/,
      max: 2,
    },
    {tool: /census_diff/, re: /^Totals:/, max: 4},
    {tool: /cache_analysis/, re: /^\| @|dev-only/, max: 8},
    {tool: /stale_collections/, re: /^\| @/, max: 5},
    {tool: /growth_signals/, re: /^\| @/, max: 5},
    {tool: /react_update_queues/, re: /^\*\*Breadth|^\| [A-Za-z]/, max: 7},
    {tool: /async_census/, re: /scheduler task record|UNSETTLED/, max: 3},
    {tool: /detached_dom/, re: /^Totals:|^\*\*/, max: 3},
    {tool: /retention_windows/, re: /window-shaped key|longer than it/, max: 3},
    {tool: /intern_opportunities/, re: /^Verdict:/, max: 2},
    {tool: /duplicate_objects/, re: /collapse to|Reclaimable/, max: 2},
    {tool: /app_heap/, re: /application|bundle/, max: 4},
  ];

/**
 * Tools whose digest is a TABLE, where `digest_rows` decides how many rows to
 * lift. Everything else has a fixed headline and is unaffected.
 *
 * The leak report is the one that matters: it printed 8 rows with full
 * retainer strings on EVERY round of a sweep, and with the idle floor
 * subtracted most rounds have one or two interesting rows. The header and
 * separator are not rows and are not counted against the budget.
 */
const ROW_TABLE_TOOLS =
  /leak_report|cache_analysis|stale_collections|growth_signals|react_update_queues/;

function digestFor(tool: string, text: string, digestRows?: number): string[] {
  const spec = DIGEST_PATTERNS.find(p => p.tool.test(tool));
  if (!spec) return [];
  const rowBudget =
    digestRows != null && ROW_TABLE_TOOLS.test(tool) ? digestRows : null;
  const out: string[] = [];
  let dataRows = 0;
  let suppressed = 0;
  for (const line of text.split('\n')) {
    if (!spec.re.test(line)) continue;
    const trimmed = line.trim();
    // A markdown separator (`|---|---|`) is part of the table, not a row.
    // It must contain a RUN of dashes: a data row whose every cell is a
    // single `—`-less placeholder dash (`| - | - |`, which several of these
    // tools emit for "not measured") is made of the same characters and was
    // being classified as a separator — so it escaped the `digest_rows`
    // budget and was neither counted nor suppressed.
    const isDataRow =
      trimmed.startsWith('|') && !/^\|[\s:|-]*-{3,}[\s:|-]*\|$/.test(trimmed);
    if (rowBudget != null && isDataRow) {
      if (dataRows >= rowBudget) {
        suppressed++;
        continue;
      }
      dataRows++;
    }
    // Stop PUSHING at the cap, but keep scanning, so `suppressed` counts
    // every row beyond the budget. Breaking here made the count depend on
    // whether headlines had already filled `out`: with enough of them the
    // note read "… 0 more row(s)" or vanished entirely, which is the
    // opposite of the guarantee that suppression is always stated.
    //
    // `digest_rows` is a promise about DATA ROWS, so `spec.max` — which
    // counts headlines and rows together — must not be able to break it. A
    // tool emitting several headlines before its table would otherwise hand
    // back fewer rows than asked for, and vary with how much prose came
    // first. Rows inside the budget go in regardless; `spec.max` still
    // governs everything else, and rows once the budget is spent.
    // Branch on the KIND first. With a row budget active, data rows push
    // unconditionally and could carry `out` past `spec.max` — and then a
    // banner or audit verdict appearing AFTER the table matched no branch
    // at all and was dropped silently, uncounted, which is the exact
    // opposite of the guarantee that headlines are never budgeted away.
    if (!isDataRow) {
      if (rowBudget != null || out.length < spec.max) out.push(trimmed);
    } else if (rowBudget != null) {
      out.push(trimmed);
    } else if (out.length < spec.max) {
      out.push(trimmed);
    } else {
      suppressed++;
    }
  }
  if (suppressed > 0) {
    out.push(
      `_… ${suppressed} more row(s) in \`${tool}.txt\` (\`digest_rows\`)._`,
    );
  }
  return out;
}

function textOf(result: unknown): string {
  const content = (result as {content?: Array<{text?: string}>})?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map(c => (typeof c?.text === 'string' ? c.text : ''))
    .join('\n');
}

/**
 * Three to five SPECIFIC next calls, derived from what the battery found.
 *
 * Not a menu. Of 120 shipped tools one measured 20-round sweep used about 20
 * and never called `memlab_tools` at all, so it never discovered
 * `memlab_compare_rounds`, `memlab_hunt_report`, `memlab_rate_model`,
 * `memlab_hypothesis`, `memlab_population_diff`, `memlab_retainer_layers` or
 * `memlab_trace_all` — several of which it then hand-rolled. The fix is not
 * more documentation: the battery already knows what it found, and
 * `memlab_detached_dom` proves the pattern works ("check it is the only door:
 * `memlab_retainer_layers({node_id: N})`" with the real id filled in is what
 * made that tool get used at all).
 *
 * Every suggestion here is therefore conditional on evidence in THIS round's
 * output and carries the argument already filled in. A suggestion that would
 * be true of any round is left out.
 */
function nextCalls(runDir: string, perTool: Map<string, string>): string[] {
  const out: string[] = [];
  // Resolved once, and used in every emitted call. The suggestions are meant
  // to be copy-pasted, and a relative `run_dir` resolves against whatever cwd
  // the next call is made from — which quietly points a follow-up at a
  // different round than the one this battery measured.
  const self = path.resolve(runDir.replace(/\/$/, ''));
  const leak = perTool.get('memlab_leak_report') ?? '';
  const settle = perTool.get('memlab_settle_check') ?? '';

  // 1. A monotonic grower with a concrete example node: is that retainer the
  //    only door, or one of several?
  const exampleId = /memlab_retainer_trace\(\{node_id: (\d+)\}\)/.exec(leak);
  if (exampleId != null && /LEAK candidate/.test(leak)) {
    out.push(
      `\`memlab_retainer_layers({node_id: ${exampleId[1]}})\` — the leak report names ONE retainer for the top candidate. ` +
        'A population with several independent holders does not shrink when the nearest one is fixed.',
    );
  }

  // 2. The class-level answer is `Object`, which names nothing.
  if (/^\| Object\s+\| object/m.test(leak)) {
    out.push(
      `\`memlab_shape_census_diff({run_dir: "${self}", class_filter: "Object"})\` — the top grower is \`Object\`, ` +
        'so the class name says nothing. Per-SHAPE growth splits it into record types in one call.',
    );
  }

  // 3. Classes that survived idle + GC are the only ones worth tracing.
  const held = /\*\*(\d+) class\(es\) survived idle \+ GC\*\*/.exec(settle);
  if (held != null && Number(held[1]) > 0) {
    // A REAL class name, lifted out of the first `held` row of the table
    // the settle check just printed. A `"<a HELD class>"` placeholder is
    // the one thing this whole section exists not to emit: a suggestion the
    // reader has to go and complete is a suggestion they will skip.
    // Escaped on the way out, not sanitised here. The name is scraped from
    // a rendered table and a JS class name can legally contain a quote or a
    // backslash — raw interpolation then produced a call that does not
    // parse, which defeats the point of filling the argument in at all.
    const heldRow = /^\|\s*([^|]+?)\s*\([a-z]+\)\s*\|.*\|\s*held\s+—/m.exec(
      settle,
    );
    const heldClass = heldRow?.[1];
    out.push(
      heldClass != null
        ? `\`memlab_trace_all({class_name: ${JSON.stringify(heldClass)}, sample_target: 40})\` — ${held[1]} class(es) survived the settle, this one among them. ` +
            'Those are the leak candidates; trace the whole population rather than a sample, since the minority path is the finding.'
        : `\`memlab_trace_all({class_name: "<a class from the HELD rows of \`memlab_settle_check.txt\`>", sample_target: 40})\` — ${held[1]} class(es) survived the settle. ` +
            'Those are the leak candidates; trace the whole population rather than a sample, since the minority path is the finding.',
    );
  } else if (settle === '') {
    out.push(
      `\`memlab_settle_check({run_dir: "${self}"})\` — this round has no settle rung, so nothing here separates retention from in-flight backlog. Re-drive with \`--settle-minutes 7\`.`,
    );
  }

  // 4. Sibling rounds in the same sweep.
  // Both sides RESOLVED. `d` is parent-joined and `runDir` may be relative,
  // so comparing them raw never matched: the current round counted itself as
  // its own sibling, inflating the count and listing the round twice in the
  // suggestion it produced.
  const parent = path.dirname(self);
  let siblings: string[] = [];
  try {
    siblings = fs
      .readdirSync(parent)
      .map(e => path.resolve(parent, e))
      .filter(d => d !== self && fs.existsSync(path.join(d, 'run.json')));
  } catch {
    siblings = [];
  }
  if (siblings.length >= 1) {
    // `self`, not `runDir`. The siblings are absolute, so a relative
    // `run_dir` produces a copy-pasteable call whose first entry is resolved
    // against the CALLER's cwd and the rest against this one — the two agree
    // only by luck, and when they do not the comparison silently runs over a
    // different round than the battery just measured.
    const SAMPLE_MAX = 3;
    const sample = [self, ...siblings].slice(0, SAMPLE_MAX);
    out.push(
      `\`memlab_compare_rounds({run_dirs: ${JSON.stringify(sample)}})\` — ${siblings.length + 1} rounds share \`${parent}\`${siblings.length + 1 > SAMPLE_MAX ? `; the call above names the first ${SAMPLE_MAX}, add the rest` : ''}. ` +
        'A per-cycle rate that lands on a whole number, and a population that grew while `app_delta` was negative, are both invisible in one round.',
    );
  }
  if (siblings.length >= 3) {
    out.push(
      `\`memlab_hunt_report({run_dirs: ${JSON.stringify([self, ...siblings])}})\` — ${siblings.length + 1} rounds is a sweep; the write-up is a tool call, not a document to assemble by hand.`,
    );
  }

  // 5. An idle control sitting unused next to this round.
  const idle = siblings.find(d => /idle/i.test(path.basename(d)));
  if (idle != null && !/Idle floor subtracted/.test(leak)) {
    out.push(
      `\`memlab_leak_report({run_dir: "${self}", baseline_run_dir: "${idle}"})\` — there is an idle control next door ` +
        'and this report did not subtract it. Some of the rows above may be what the app allocates with no interaction at all.',
    );
  }
  return out.slice(0, 5);
}

export function registerAnalysisBattery(server: McpServer): void {
  server.tool(
    'memlab_analysis_battery',
    "Run a round's whole analysis in ONE call, write every tool's output to disk, and return only a digest.\n\n" +
      "The snapshot load dominates the cost of every tool, so running the standard set over one resident graph costs roughly what running three of them separately does. The reason this is a separate tool from `memlab_batch` is the OUTPUT: a batch returns every result inline, and a round's worth of tool prose is tens of thousands of tokens — which is why a twenty-round sweep is impossible to read without this. Detail goes to `<out_dir>/<tool>.txt`; the digest that comes back is the audit verdict, the app-vs-artifact split, the top growers with rate and fit, census totals and the named collections.\n\n" +
      'Give it `run_dir` and it resolves the ladder, the per-rung cycle counts and the total cycles from `run.json`, so the per-cycle axis is measured rather than assumed.\n\n' +
      'When the round captured a settle rung, `memlab_settle_check` runs in EVERY profile and its `N HELD / M DRAINED` headline is in the digest: a ladder alone cannot tell retention from in-flight backlog, and a round without that line has a leak list that is mostly backlog.\n\n' +
      'Profiles: `standard` (ladder + leak detectors), `optimization` (adds string/shape/duplication analysis), `deep` (everything, including the slower single-snapshot passes).',
    {
      run_dir: z
        .string()
        .describe(
          "The leak-hunt round's output directory — the one holding run.json and snapshots/.",
        ),
      out_dir: z
        .string()
        .optional()
        .describe(
          'Where to write the per-tool output files. Defaults to `<run_dir>/analysis`.',
        ),
      profile: z
        .enum(['standard', 'optimization', 'deep'])
        .optional()
        .default('standard')
        .describe(
          'Which tool set to run. `standard` is the leak-hunt set; `optimization` adds duplication/interning/shape analysis; `deep` runs everything and is materially slower.',
        ),
      timeout_ms: z
        .number()
        .optional()
        .describe(
          'Budget for the whole battery. Checked BETWEEN steps — a whole-heap pass is one synchronous block and cannot be interrupted — so the guarantee is that no NEW step starts past the deadline.',
        ),
      digest_rows: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(5)
        .describe(
          'How many TABLE rows each row-shaped tool contributes to the digest (default 5). `memlab_leak_report` printed 8 rows with full retainer strings on every round of a sweep, and with the idle floor subtracted most rounds have one or two interesting ones. Headline lines are never budgeted away, and the full table is always in `<out_dir>/<tool>.txt`.',
        ),
      async: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Return a handle IMMEDIATELY and run the battery in the background; poll it with `memlab_battery_status({battery_id})`, which hands back the full report once it is done. A standard battery is 7-10 minutes, so every call of it exceeds the generic tool timeout and is backgrounded — this makes the wait explicit and pollable instead, with no interleaved completion notification. Per-tool output still lands in `<out_dir>/<tool>.txt` as each step finishes, so a specific question can be answered before the battery is.',
        ),
    },
    async (
      {run_dir, out_dir, profile, timeout_ms, digest_rows, async: runAsync},
      extra,
    ) => {
      try {
        const manifest = loadRunManifest(run_dir);
        if (manifest.paths.length < 2) {
          return errorResult(
            new Error(
              `run.json lists ${manifest.paths.length} rung(s); a battery needs at least 2.`,
            ),
          );
        }
        const missing = manifest.paths.filter(p => !snapshotExists(p));
        if (missing.length > 0) {
          return errorResult(
            new Error(
              `${missing.length} rung file(s) named in run.json are missing:\n` +
                missing.map(m => `- ${m}`).join('\n'),
            ),
          );
        }

        const outDir =
          out_dir ?? path.join(run_dir.replace(/\/$/, ''), 'analysis');
        fs.mkdirSync(outDir, {recursive: true});
        // Two batteries writing one directory overwrite each other's
        // `<tool>.txt` file by file, and the loser's report cites paths
        // holding the winner's output — silently, since each write
        // succeeds. The default directory is derived from `run_dir`, so
        // this is the ordinary case of analysing one round twice at once,
        // not an exotic one. Refused rather than interleaved.
        //
        // A RESERVATION, not a scan of the tracked map. Scanning missed two
        // cases: a synchronous run is not in `batteries` while it works, and
        // an evicted-but-still-running one has been removed from it — both
        // keep writing to their directory. And the scan was a check the
        // caller could pass before the other run registered. Claiming the
        // path here, synchronously and before any await, has none of those
        // gaps.
        const outKey = path.resolve(outDir);
        const heldBy = activeOutDirs.get(outKey);
        if (heldBy != null) {
          return errorResult(
            new Error(
              `Battery \`${heldBy}\` is already running and writing to \`${outDir}/\`. ` +
                "Two batteries sharing one output directory overwrite each other's per-tool files. " +
                `Wait for it (\`memlab_battery_status({battery_id: "${heldBy}"})\`), or pass a different \`out_dir\`.`,
            ),
          );
        }

        // Free space, checked BEFORE the work rather than discovered during
        // it. One sweep wrote 101 snapshots at 358-526 MB — ~40 GB — and
        // nothing warned; a hunt that fills the disk mid-round loses the
        // lease that produced the rungs, which cannot be re-captured.
        //
        // A compressed rung counts as what it becomes, not what it is on
        // disk. Analysis decompresses each one to a temp file first, so
        // summing the archive sizes reports a fifth of the space the battery
        // is about to need — the headroom check then passes on exactly the
        // pruned rounds where disk is already tight. 7x is the middle of the
        // 5-10x a heap snapshot achieves, the same figure `memlab_prune_run`
        // estimates with.
        const GZ_EXPANSION = 7;
        const ladderBytes = manifest.paths.reduce((sum, p) => {
          try {
            if (fs.existsSync(p)) return sum + fs.statSync(p).size;
            return sum + fs.statSync(`${p}.gz`).size * GZ_EXPANSION;
          } catch {
            return sum;
          }
        }, 0);
        // The TIGHTER of the two volumes the battery writes to. Reports land
        // in `outDir`; a compressed rung is decompressed full-size into
        // `os.tmpdir()`, which is very often a different filesystem (and on
        // some hosts a small one). Checking only `outDir` reassures about a
        // volume the decompression never touches.
        const freeOn = (dir: string): number => {
          try {
            const st = fs.statfsSync(dir);
            return Number(st.bavail) * Number(st.bsize);
          } catch {
            // statfs is unavailable on some platforms; no warning is better
            // than a wrong one.
            return -1;
          }
        };
        const freeOut = freeOn(outDir);
        const anyCompressed = manifest.paths.some(p => !fs.existsSync(p));
        const freeTmp = anyCompressed ? freeOn(os.tmpdir()) : -1;
        // The tighter of whichever volumes could be measured. Requiring
        // BOTH silenced the warning entirely when `statfs` failed on the
        // output volume — and a host where statfs fails on the volume the
        // reports land in is not a host where disk pressure is less likely.
        const known = [freeOut, freeTmp].filter(b => b >= 0);
        const freeBytes = known.length > 0 ? Math.min(...known) : -1;
        // A manifold-backed run has no local file for either form, so every
        // stat throws and `ladderBytes` stays 0 — which reads as "no
        // headroom needed" and silences the warning on the runs that fetch
        // the most data. Unknown is not zero: say so instead.
        const sizeUnknown = ladderBytes === 0 && manifest.paths.length > 0;
        const lowDisk =
          freeBytes >= 0 && ladderBytes > 0 && freeBytes < ladderBytes * 3;

        const finalRung = manifest.paths[manifest.paths.length - 1];
        const baseRung = manifest.paths[0];
        const hasSettleRung =
          manifest.settleRungPath != null &&
          snapshotExists(manifest.settleRungPath);
        const plan = buildPlan(
          profile,
          run_dir,
          manifest.paths,
          manifest.cycles,
          finalRung,
          baseRung,
          hasSettleRung,
        );

        const progress = makeProgressReporter(extra, 'battery');
        const tracked: BatteryRun = {
          id: `battery-${++batterySeq}`,
          runDir: run_dir,
          profile,
          outDir,
          startedAt: Date.now(),
          finishedAt: null,
          totalSteps: plan.length,
          doneSteps: 0,
          currentTool: null,
          result: null,
          error: null,
        };

        // Everything below is the battery itself, extracted so it can be
        // either awaited or detached behind a handle.
        const execute = async (): Promise<string> => {
          // Started HERE, not at call time. A detached run begins after the
          // handle is returned, and with `wait_for_rungs` that can be many
          // minutes later — so a deadline stamped at call time had already
          // partly or wholly elapsed before the first step, and every step
          // was skipped for a budget the battery never got to spend.
          const deadline =
            timeout_ms != null && timeout_ms > 0
              ? Date.now() + timeout_ms
              : null;
          const digestLines: string[] = [];
          const written: Array<{tool: string; bytes: number; ms: number}> = [];
          // Kept so the report can quote a headline out of a tool's full
          // output rather than re-deriving it from the digest's clipped
          // lines.
          const perToolText = new Map<string, string>();
          const failures: string[] = [];
          let skipped = 0;
          // Every step whose args name no snapshot of their own reads whatever
          // `memlab_load_snapshot` left resident. If that load failed, running
          // them anyway meant censusing a STALE snapshot (or none), and
          // `digestFor` then lifted plausible-looking lines into the returned
          // digest as though they described this round — a silently wrong answer
          // with nothing in the output saying so.
          const needsResidentSnapshot = (step: Step): boolean => {
            const a = step.args as Record<string, unknown>;
            return (
              a.run_dir == null &&
              a.paths == null &&
              a.file_path == null &&
              a.baseline == null &&
              a.target == null
            );
          };
          let loadFailed = false;
          // One counter for "how far through the plan are we", used by BOTH
          // the streamed phase index and the status handle. Deriving them
          // separately — `written.length + skipped` for one, `written.length`
          // for the other — makes them disagree the moment a step neither
          // writes nor counts as skipped (an unregistered tool, a failed
          // write), and a progress line that goes backwards reads as a hang.
          let finished = 0;

          for (const step of plan) {
            finished++;
            // A load that never RAN leaves the previous round's snapshot resident,
            // which is the same wrong answer as a load that ran and failed — so
            // the two skip paths below have to set `loadFailed` as well.
            const isLoad = step.tool === 'memlab_load_snapshot';
            if (deadline != null && Date.now() > deadline) {
              skipped++;
              if (isLoad) loadFailed = true;
              tracked.doneSteps = finished;
              continue;
            }
            if (loadFailed && needsResidentSnapshot(step)) {
              skipped++;
              failures.push(
                `${step.tool}: skipped — the snapshot load it depends on did not succeed`,
              );
              tracked.doneSteps = finished;
              continue;
            }
            const entry = getRegisteredTool(step.tool);
            if (entry == null) {
              // A profile naming a tool this build does not have is a bug in the
              // profile, not a reason to abandon the round.
              failures.push(`${step.tool}: not registered in this build`);
              if (isLoad) loadFailed = true;
              tracked.doneSteps = finished;
              continue;
            }
            const started = Date.now();
            tracked.currentTool = step.tool;
            progress.phase(finished, plan.length, step.tool);
            let text: string;
            try {
              const parsed =
                entry.shape != null
                  ? z.object(entry.shape as never).parse(step.args)
                  : step.args;
              text = textOf(await entry.handler(parsed, {}));
            } catch (err: unknown) {
              text = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
              failures.push(`${step.tool}: ${text.slice(0, 160)}`);
            }
            // Both spellings of failure: a thrown error and an error RESULT,
            // which `errorResult` returns as text rather than throwing.
            if (
              step.tool === 'memlab_load_snapshot' &&
              /^(ERROR|❌|Error:)/.test(text.trimStart())
            ) {
              loadFailed = true;
            }
            const ms = Date.now() - started;
            const file = path.join(outDir, `${step.tool}.txt`);
            // Recorded BEFORE the write: the app_delta headline is lifted
            // from this map, and a failed disk write is no reason to lose it.
            perToolText.set(step.tool, text);
            try {
              fs.writeFileSync(file, text, 'utf8');
              written.push({tool: step.tool, bytes: text.length, ms});
            } catch (err: unknown) {
              // Inside the per-step boundary, like the tool call above it. A
              // write failure — a full disk being the realistic one, and this
              // battery is what fills disks — used to reject the whole
              // detached promise, so `memlab_battery_status` reported FAILED
              // with only that message and discarded every digest line
              // already accumulated. That is the opposite of the per-step
              // isolation the rest of this loop implements.
              failures.push(
                `${step.tool}: output not written — ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            tracked.doneSteps = finished;

            const d = digestFor(step.tool, text, digest_rows);
            if (d.length > 0) {
              digestLines.push(`### ${step.tool}`, ...d, '');
            }
          }

          // The one number every other number is read against, lifted out of
          // `artifact_budget` and put ABOVE the digest. A figure that has to
          // be found in section four is a figure that gets skipped, and then
          // a +44 MB app_delta hides behind a +1.5 MB post-GC total (or the
          // reverse).
          const appDeltaLine = (() => {
            const text = perToolText.get('memlab_artifact_budget');
            if (text == null) return null;
            const m = /^\*\*app_delta:.*$/m.exec(text);
            return m ? m[0] : null;
          })();

          const lines: string[] = [
            `## Analysis battery — \`${path.basename(run_dir.replace(/\/$/, ''))}\` (${profile})`,
            '',
            ...(appDeltaLine != null
              ? [
                  appDeltaLine +
                    ' — the application-side change, and the number every other figure below is read against. ' +
                    'The post-GC total is not it: on one round app_delta was +44.2 MB while the total moved +1.5 MB.',
                  '',
                ]
              : []),
            `${manifest.paths.length} rungs at cycles [${manifest.cyclesPerRung.join(', ')}], ` +
              `${formatNumber(manifest.cycles)} cycles driven` +
              (manifest.combos.length > 0
                ? `, combos: ${manifest.combos.join(', ')}`
                : '') +
              '.',
            '',
            ...(lowDisk
              ? [
                  `> ⚠️ **Low disk: ${formatBytes(freeBytes)} free, against a ${formatBytes(ladderBytes)} ladder** (the tighter of the output volume and the temp volume a compressed rung expands into). ` +
                    'Below ~3x the ladder size a sweep is at risk of dying mid-round, and a lost round costs the lease that produced it. ' +
                    '`memlab_prune_run({run_dir, mode: "compress"})` on FINISHED rounds gzips their rungs ~5-10x and leaves them analysable.',
                  '',
                ]
              : sizeUnknown
                ? [
                    "> ⚠️ **Disk headroom not checked**: none of this round's rungs is a local file (a `manifold://` run), so their size is not knowable before the fetch. Watch free space yourself — a sweep that fills the disk mid-round loses the lease that produced it.",
                    '',
                  ]
                : []),
            `**${written.length} tool(s) run**, output written to \`${outDir}/\`` +
              (skipped > 0 ? `; ${skipped} skipped for budget` : '') +
              (failures.length > 0 ? `; ${failures.length} failed` : '') +
              '.',
            '',
          ];

          if (manifest.caveats.length > 0) {
            lines.push('**Caveats recorded by the runner:**');
            for (const c of manifest.caveats) lines.push(`- ${c}`);
            lines.push('');
          }
          if (manifest.splitAfterRung.length > 0) {
            lines.push(
              `> ⚠️ **LADDER SPLIT after rung ${manifest.splitAfterRung.join(', ')}** — rungs across that ` +
                'boundary are different V8 isolates and must not be compared. Analyze each segment on its own.',
              '',
            );
          }

          lines.push('## Digest', '');
          lines.push(
            digestLines.length > 0
              ? digestLines.join('\n')
              : '_No digest lines matched; read the files below._',
          );
          lines.push('');

          if (failures.length > 0) {
            lines.push('## Failed steps', '');
            for (const f of failures) lines.push(`- ${f}`);
            lines.push('');
          }

          lines.push('## Files', '');
          for (const w of written.sort((a, b) => b.bytes - a.bytes)) {
            lines.push(
              `- \`${w.tool}.txt\` — ${formatNumber(w.bytes)} B, ${formatNumber(w.ms)} ms`,
            );
          }
          const suggestions = nextCalls(run_dir, perToolText);
          if (suggestions.length > 0) {
            lines.push('', '## Next', '');
            for (const sug of suggestions) lines.push(`- ${sug}`);
          }

          lines.push('');
          lines.push(
            `_Full output for any tool is at \`${outDir}/<tool>.txt\`. The digest above is fixed and ` +
              'small on purpose: a round should cost a bounded number of tokens to read, with the ' +
              'detail still on disk when a specific question needs it._',
          );

          return lines.join('\n');
        };

        // Claimed for the whole life of the run, released on every exit
        // path below.
        activeOutDirs.set(outKey, tracked.id);
        const release = (): void => {
          if (activeOutDirs.get(outKey) === tracked.id) {
            activeOutDirs.delete(outKey);
          }
        };
        // A WATCHDOG, because the release paths all depend on the run
        // settling. A step that hangs — a snapshot load wedged on a
        // network mount is the realistic one — never resolves and never
        // rejects, so the claim would be held for the life of the
        // process and every later battery on that round refused. The
        // timer is generous (well past any real battery) and unref'd so
        // it cannot by itself keep the process alive.
        const watchdog = setTimeout(() => {
          if (activeOutDirs.get(outKey) === tracked.id) {
            process.stderr.write(
              `[battery ${tracked.id}] still holding ${outDir} after ` +
                `${Math.round(RESERVATION_MAX_MS / 60000)} min; releasing the ` +
                'claim so another battery can use it. The run itself was not ' +
                'cancelled.\n',
            );
            activeOutDirs.delete(outKey);
          }
        }, RESERVATION_MAX_MS);
        if (typeof watchdog.unref === 'function') watchdog.unref();
        const finish = (): void => {
          clearTimeout(watchdog);
          release();
        };

        // Synchronous by default: a short battery answered inline is simpler
        // than a handle nobody has to poll.
        if (runAsync !== true) {
          try {
            return toolResult(await execute());
          } finally {
            finish();
          }
        }

        // Guarded, so the reservation cannot outlive the attempt. If
        // `trackBattery` throws here the handler unwinds before the
        // completion callbacks are attached, and the claim on this
        // directory would then be held by nothing for the life of the
        // process — every later battery on the same round refused with a
        // battery id that does not exist.
        try {
          trackBattery(tracked);
        } catch (e) {
          finish();
          throw e;
        }
        void execute().then(
          text => {
            tracked.result = text;
            tracked.finishedAt = Date.now();
            tracked.currentTool = null;
            finish();
          },
          err => {
            const message = err instanceof Error ? err.message : String(err);
            // To stderr as well as to the handle. The handle is in-memory
            // and only ever read by a `memlab_battery_status` call that may
            // never come — the caller moved on, or the run was evicted — and
            // then the sole record of why a detached run died is gone. Every
            // per-step line already streams here, so the terminal failure
            // belongs in the same place.
            process.stderr.write(
              `[battery ${tracked.id}] FAILED: ${message}\n`,
            );
            tracked.error = message;
            tracked.finishedAt = Date.now();
            tracked.currentTool = null;
            finish();
          },
        );
        return toolResult(
          [
            `## Battery started — \`${tracked.id}\``,
            '',
            `\`${path.basename(run_dir.replace(/\/$/, ''))}\` (${profile}), ${plan.length} tool(s), writing to \`${outDir}/\`.`,
            '',
            `Poll it with \`memlab_battery_status({battery_id: "${tracked.id}"})\`. The full report comes back from that call once it finishes; per-tool output lands in \`${outDir}/<tool>.txt\` as each step completes, so a specific question can be answered before the whole battery is done.`,
            '',
            '_A standard battery is 7-10 minutes. Started this way it does not occupy the tool timeout, so there is no backgrounding and no interleaved completion notification — but nothing polls on your behalf either._',
          ].join('\n'),
        );
      } catch (e: unknown) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    'memlab_battery_status',
    'Report on a battery started with `memlab_analysis_battery({async: true})`, and return its full report once it has finished. With no `battery_id`, lists the batteries this server knows about.',
    {
      battery_id: z
        .string()
        .optional()
        .describe(
          'The id returned by `memlab_analysis_battery({async: true})`. Omit to list every tracked battery.',
        ),
    },
    async ({battery_id}) => {
      if (battery_id == null || battery_id === '') {
        const all = [...batteries.values()];
        if (all.length === 0) {
          return toolResult(
            'No battery has been started with `async: true` in this server process. `memlab_analysis_battery({run_dir, async: true})` starts one.',
          );
        }
        return toolResult(
          [
            `## Batteries (${all.length})`,
            '',
            ...all.map(
              b =>
                `- \`${b.id}\` — ${path.basename(b.runDir.replace(/\/$/, ''))} (${b.profile}), ` +
                (b.finishedAt != null
                  ? `${b.error != null ? 'FAILED' : 'done'} in ${formatNumber(Math.round((b.finishedAt - b.startedAt) / 1000))}s`
                  : `running, step ${b.doneSteps}/${b.totalSteps}${b.currentTool != null ? ` (${b.currentTool})` : ''}`),
            ),
          ].join('\n'),
        );
      }
      const run = batteries.get(battery_id);
      if (run == null) {
        // A restarted server loses the map, and that is the likeliest cause —
        // say so, and name the directory the work would have landed in, since
        // the per-tool files survive the process that wrote them.
        const dropped = evicted.get(battery_id);
        if (dropped != null) {
          // The evicted run kept running, and the closure that finishes it
          // writes onto the object we are holding — so if it has since
          // completed, the report is right here. Reporting EVICTED and
          // pointing at the files while the full text sits in memory is a
          // worse answer than simply returning it.
          if (dropped.finishedAt != null && dropped.result != null) {
            return toolResult(
              `_(This battery's handle had been evicted to bound the tracking map — more than ${MAX_TRACKED_BATTERIES} were started — but the run completed and its report was still in memory.)_\n\n${dropped.result}`,
            );
          }
          return errorResult(
            new Error(
              `Battery \`${battery_id}\` ran in this process but its handle was EVICTED — more than ${MAX_TRACKED_BATTERIES} batteries were started and the oldest still-running handles are dropped to bound the map. ` +
                `${dropped.error != null ? `It then FAILED: ${dropped.error}. ` : 'It is still running or was interrupted. '}` +
                `Its per-tool output is in \`${dropped.outDir}/\`; only the pollable report is gone. ` +
                'Start fewer concurrent batteries, or read the files directly.',
            ),
          );
        }
        return errorResult(
          new Error(
            `No battery \`${battery_id}\` in this server process. ` +
              'A server restart drops the handle (the per-tool `.txt` files on disk survive it). ' +
              '`memlab_battery_status()` with no id lists what IS tracked.',
          ),
        );
      }
      const elapsed = Math.round(
        ((run.finishedAt ?? Date.now()) - run.startedAt) / 1000,
      );
      if (run.finishedAt == null) {
        return toolResult(
          `## \`${run.id}\` — RUNNING (${formatNumber(elapsed)}s)\n\n` +
            // PROCESSED, not "done". The counter advances once per plan
            // entry so the progress line cannot go backwards, which means it
            // also counts a step that was skipped for budget or was not
            // registered in this build — neither of which produced output.
            // Calling those "done" overstates what is on disk.
            `${run.doneSteps}/${run.totalSteps} step(s) processed` +
            (run.currentTool != null
              ? `, now running \`${run.currentTool}\``
              : '') +
            `. Output so far is in \`${run.outDir}/\`.\n\n` +
            '_Poll again rather than waiting: each completed tool has already written its full output to disk._',
        );
      }
      if (run.error != null) {
        return errorResult(
          new Error(
            `Battery \`${run.id}\` FAILED after ${formatNumber(elapsed)}s: ${run.error}\n\n` +
              `${run.doneSteps}/${run.totalSteps} step(s) had been processed; whatever produced output is in ${run.outDir}/.`,
          ),
        );
      }
      return toolResult(
        `_Battery \`${run.id}\` finished in ${formatNumber(elapsed)}s._\n\n${run.result ?? ''}`,
      );
    },
  );
}
