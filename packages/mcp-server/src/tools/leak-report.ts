/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {
  ladderSpanSeconds,
  resolveLadderInputs,
  describeSegmentSelection,
  SEGMENT_ARG_DESCRIPTION,
  retentionWindowCaveat,
} from '../run-manifest.js';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode} from '@memlab/core';
import fs from 'fs';
import path from 'path';
import {z} from 'zod';
import memlabHeapAnalysis from '@memlab/heap-analysis';
const {getFullHeapFromFile} = memlabHeapAnalysis;
import {
  capReportSize,
  clampLabel,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  pathsHeader,
  toolResult,
} from '../utils.js';
import {artifactLabel} from '../artifact-classes.js';
import {
  buildHistogram,
  computeSequenceTrends,
  normalizeClassName,
  type SequenceRow,
} from './sequence-analysis.js';
import {resolveRungs, withSnapshotAt} from '../snapshot-borrow.js';
import {
  collectDevRoots,
  computeReachableWithoutDevRoots,
} from './dev-artifacts.js';
import {getFirstNonFrameworkRetainer} from './detached-dom.js';
import {
  DEV_ONLY_FOOTNOTE,
  GATED_FOOTNOTE,
  moduleProvenanceOf,
} from '../dev-modules.js';
import {makeProgressReporter} from '../progress.js';

// Nodes kept per candidate class for the retainer sample. Small on purpose: the
// question is "what shape of thing holds these", and a handful of instances
// answers it — walking thousands would cost more than the trend pass itself.
const MAX_SAMPLES_PER_CLASS = 8;

/**
 * Instances per class the dev-MODULE provenance walk runs on.
 *
 * Its own budget, not shared with the retainer sample: the walk climbs up to
 * 12 path edges per node, and running it over a 300,000-member class would
 * cost more than the trend pass it annotates. Counting it against the
 * retainer window made the denominator vary per class, so the majority test
 * below compared against a number that was not the number sampled.
 */
const PROVENANCE_SAMPLES = 8;
const RETAINER_SAMPLES = 3;

// A class whose instances are overwhelmingly dev-root-retained is a measurement
// artifact in production terms, whatever its growth curve looks like. Matches
// the majority-not-any threshold intern_opportunities uses, for the same reason:
// a class can legitimately mix a few console-held instances with real data.
const DEV_ONLY_SHARE = 0.8;

interface Evidence {
  total: number;
  devOnly: number;
  /**
   * Samples whose shortest path runs through a dev-only or flag-gated MODULE.
   *
   * A different check from `devOnly`, which counts instances retained through
   * a dev ROOT (a console handle, a Fast Refresh registry). A dev-only module
   * holding ordinary references passes that check completely —
   * `memlab_cache_analysis` added this test for exactly that reason, and
   * caught a 12.7 MB Map with it. `traceVisualCompletionMetrics` cost one
   * sweep four separate filings of the same browser-tools interop before
   * anyone noticed it was not the app.
   */
  devModule: number;
  gatedModule: number;
  /** How many instances the provenance walk was actually run on. */
  provSampled: number;
  devWhy: string | null;
  gatedWhy: string | null;
  // Only instances with a retainer path are sampled: the sample exists to be
  // walked upward, and a node with no path edge yields "(unknown)" every time.
  samples: IHeapNode[];
  // The newest traceable instances, kept as a min-heap-ish sorted window of the
  // highest node ids. V8 assigns heap-snapshot node ids monotonically as objects
  // are allocated, so the highest ids in a class ARE its most recently created
  // instances — which is the cohort the ladder's growth is made of. See
  // `growthSamples` below for why this, and not `samples`, drives the retainer
  // column.
  newest: IHeapNode[];
  // Largest traceable instance — what the follow-up retainer_trace should
  // target. `anyExample` is the fallback when nothing in the class is
  // traceable, so the report still names a node instead of nothing.
  example: IHeapNode | null;
  exampleRetained: number;
  anyExample: IHeapNode | null;
}

// Deliberately NOT a sum of retainedSize across the class: retained sizes
// overlap wherever instances nest, so summing them reports figures larger than
// the heap (measured: 5.9 GB of `Object` in a 200 MB heap). Net self-size delta
// across the ladder is additive and is the growth the report is about anyway.
/**
 * The class name to PRINT.
 *
 * Clamped, because for a `string`-typed row the class name IS the string's
 * content. Measured: one round of this tool wrote a 42,682,152-byte file
 * against a 6,440-byte median across the same 20-round sweep, entirely from
 * multi-megabyte string names reaching the parts of the report that did not
 * truncate.
 */
const DISPLAY_NAME_MAX = 120;

function displayName(row: {name: string; type: string}): string {
  return row.name.length > 0
    ? clampLabel(row.name, DISPLAY_NAME_MAX)
    : `(unnamed ${row.type})`;
}

/**
 * `displayName` for PROSE, where a class name is interpolated into a sentence.
 *
 * The table truncates its own cells; the suggestion trailers did not, and for a
 * string-typed row the "class name" IS the string's content. A single measured
 * `**Next:**` line carried a whole multi-line `Error: [ProxyState] …` value
 * including three full bundle URLs with query strings — several hundred tokens
 * of payload inside a line whose only job is to name the next tool to run. The
 * newline collapse matters as much as the length cap: an embedded newline also
 * breaks out of the markdown bullet it was sitting in.
 */
const PROSE_NAME_MAX = 80;

/**
 * Past this, a class name is not inlined into a copy-paste tool call at all.
 * A CLIPPED name still reads as pasteable and matches nothing.
 */
const PASTEABLE_NAME_MAX = 200;

function proseName(row: {name: string; type: string}): string {
  const flat = displayName(row).replace(/\s+/g, ' ').trim();
  return flat.length > PROSE_NAME_MAX
    ? `${flat.slice(0, PROSE_NAME_MAX - 1)}…`
    : flat;
}

/**
 * The idle control round sitting next to this one, if a sweep left one there.
 *
 * A sweep drives an idle control round once and names it for what it is
 * (`r239-idle`, `idle-control`, …). Finding it automatically is the difference
 * between the floor being subtracted on every round and it being subtracted on
 * the rounds someone remembered — measured, that was none of twenty.
 *
 * Deliberately conservative: only a SIBLING directory, only one whose name
 * contains "idle", and only one that has a run.json. More than one match is
 * refused rather than guessed, since picking the wrong control silently
 * changes every rate in the table.
 */
export function findIdleSibling(runDir: string): string | null {
  const self = path.resolve(runDir.replace(/\/$/, ''));
  const parent = path.dirname(self);
  if (parent === self) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return null;
  }
  // A TOKEN, not a substring, and a directory. `/idle/i` also matches
  // `idle-notes`, and a single such sibling holding a run.json would silently
  // become the floor every row is ranked against — the exact corruption the
  // docstring above warns about.
  const hits = entries
    .filter(e => /(^|[-_.])idle([-_.]|$)/i.test(e))
    .map(e => path.join(parent, e))
    .filter(p => {
      if (p === self) return false;
      try {
        return (
          fs.statSync(p).isDirectory() &&
          fs.existsSync(path.join(p, 'run.json'))
        );
      } catch {
        return false;
      }
    });
  return hits.length === 1 ? hits[0] : null;
}

function modalRetainer(nodes: readonly IHeapNode[]): {
  label: string;
  votes: number;
  of: number;
} {
  const counts = new Map<string, number>();
  let considered = 0;
  for (const node of nodes.slice(0, RETAINER_SAMPLES)) {
    considered++;
    const label = getFirstNonFrameworkRetainer(node);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let best = '(unknown)';
  let bestCount = 0;
  for (const [label, c] of counts) {
    if (c > bestCount) {
      best = label;
      bestCount = c;
    }
  }
  return {label: best, votes: bestCount, of: considered};
}

/**
 * The retainer to report for a GROWING class.
 *
 * This used to vote over instances sampled from the class's whole final
 * population, which answers the wrong question: it reports whoever holds the
 * MOST instances, not whoever holds the NEW ones. Those differ exactly when a
 * large static collection coexists with a small accumulating one — which is the
 * common case, and the case the report exists to diagnose.
 *
 * Measured failure this fixes: across three separate rounds the `Set` class was
 * growing by ~2,000 instances and the column named `CometStyleXSheet
 * .externalRules`, a collection that a per-rung trend pass shows is FLAT at
 * 9,356 entries at every rung. It contributed none of the growth; it was simply
 * the largest static Set population in the heap, so it won every vote. A reader
 * who trusts the column chases a collection that is not moving.
 *
 * The growth cohort is approximated by node id: V8 assigns heap-snapshot ids
 * monotonically as objects are allocated, so the highest-id instances of a class
 * are its newest. That is a heuristic — ids are not a timestamp and a class can
 * churn — so when the two cohorts disagree the report says so rather than
 * silently preferring one.
 */
function growthRetainer(ev: Evidence): {
  label: string;
  votes: number;
  of: number;
  populationLabel: string | null;
} {
  const growth = modalRetainer(ev.newest);
  const population = modalRetainer(ev.samples);
  return {
    ...growth,
    populationLabel:
      growth.label !== population.label && population.label !== '(unknown)'
        ? population.label
        : null,
  };
}

/**
 * Ratios that land on a whole number, and what they mean.
 *
 * Turning a delta into a mechanism is usually one division. The breakthrough on
 * one investigation was noticing that a population grew by 19 rows per cycle on
 * an account with exactly 19 chats: the leaked unit was one whole chat list, so
 * the cost scaled with the USER'S data rather than with elapsed time — a
 * different severity and a different fix from "grows over time". That division
 * was done by eye, and only because someone happened to know the chat count.
 *
 * `tolerance` is an ABSOLUTE distance from the nearest integer, and has to be:
 * scaling it by the ratio makes every large ratio trivially "integer", which is
 * the difference between a signal and noise dressed as one. Measured against a
 * real 3-rung ladder with a 2%-of-ratio tolerance, EVERY candidate row reported
 * a clean whole number — `16,825 / 50 = 336.5` was announced as "337 per cycle"
 * because 0.5 is comfortably inside 2% of 337. With an absolute 0.02 the same
 * row is correctly rejected and only a ratio that really does land on an
 * integer survives.
 */
export function integerRatios(
  netCount: number,
  content: Record<string, number>,
  tolerance = 0.02,
): Array<{key: string; per: number}> {
  const out: Array<{key: string; per: number}> = [];
  for (const [key, count] of Object.entries(content)) {
    if (!Number.isFinite(count) || count <= 0) continue;
    const ratio = netCount / count;
    if (ratio < 1) continue;
    const nearest = Math.round(ratio);
    if (nearest >= 1 && Math.abs(ratio - nearest) <= tolerance) {
      out.push({key, per: nearest});
    }
  }
  return out;
}

export function registerLeakReport(server: McpServer): void {
  server.tool(
    'memlab_leak_report',
    'One-call leak triage across an ORDERED ladder of >=2 heap snapshots: runs the growth-trend pass, then gathers per-class EVIDENCE from the final snapshot and returns a single table — class, per-rung counts, Δ and Δ/cycle, how much of it is dev/automation-retained, the dominant retainer, and a verdict hint. ' +
      'Exists because the trend pass alone cannot tell a leak from an artifact: every hunt then ran memlab_dev_artifacts and a retainer trace by hand on each grower and joined the three outputs mentally, which is the step that gets skipped right before something is reported as a production leak. Composes memlab_sequence_analysis with memlab_dev_artifacts and a retainer sample; costs one extra snapshot load (the last rung) on top of the ladder pass. ' +
      "When `run_dir` names a round that captured a SETTLE rung, every row also carries how much of its growth survived idle + GC, and a class that DRAINS is labelled backlog rather than a leak candidate — without that column the default table is mostly backlog (measured: one sweep's settle rungs retired 92,452 objects and 26.3 MB the ladder had called leaks). A round with no settle rung is stamped UNSETTLED. " +
      'The verdict column is a HINT, not a conclusion — confirm a candidate with memlab_retainer_trace on the example node before calling it a leak. ' +
      "The retainer column votes over the class's NEWEST instances (highest node ids = the growth cohort), NOT over its whole population: voting over the population names whoever holds the most instances, which is a large STATIC collection whenever one exists and is not what grew. Rows where the two disagree are listed under the table. Paths may be local, manifold:// URLs, or bare filenames.",
    {
      run_dir: z
        .string()
        .optional()
        .describe(
          "A leak-hunt round's output directory (the one holding run.json and snapshots/). PREFERRED over `paths`: the rung paths and the exact cycles driven are read from run.json, so the per-cycle axis is measured rather than assumed. Rungs are placed on a schedule, so a real ladder is unevenly spaced (e.g. 0/200/375/450).",
        ),
      segment: z
        .union([z.number().int().nonnegative(), z.literal('all')])
        .optional()
        .describe(SEGMENT_ARG_DESCRIPTION),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Ordered list of >=2 snapshot paths (oldest first): local absolute paths, manifold:// URLs, or bare snapshot filenames. A single ["ladder:<name>"] entry expands to a ladder saved with memlab_ladder. Ignored when `run_dir` is given.',
        ),
      // Accepts a total OR a per-rung axis. memlab_ladder_probe, which is the
      // tool called immediately before or after this one on the same ladder,
      // spells the per-rung form `cycles_per_rung` and also accepts `cycles`,
      // so passing `[0, 1000, 2000, 3000]` here is the natural mistake and used
      // to hard-fail with "Expected number, received array".
      cycles: z
        .union([z.number(), z.array(z.number())])
        .optional()
        .describe(
          'Interaction cycles driven between the FIRST and LAST snapshot. When provided, a "Δ/cycle" column is reported — a per-cycle rate is what says whether growth scales with interaction, which a total cannot. An ARRAY is also accepted and read as the per-rung cumulative axis (e.g. [0, 1000, 2000, 3000]), same as `cycles_per_rung` elsewhere. Prefer `run_dir`, which reads the exact axis from run.json.',
        ),
      content: z
        .record(z.number())
        .optional()
        .describe(
          'Counts of the CONTENT the driven surface contains — e.g. {"chats": 19, "messages": 40}. Read from run.json `environment.content` when `run_dir` is given and this is not. When given, each grower\'s net delta is also divided by these, and any ratio landing on a whole number is called out. This is what turns a number into a mechanism: a class growing by exactly one unit per chat is leaking a whole chat list per cycle, and scales with the user\'s data rather than with time.',
        ),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe(
          'Maximum number of growing classes to gather evidence for (default 10).',
        ),
      min_growth_count: z
        .number()
        .optional()
        .default(50)
        .describe(
          'Only consider classes whose net instance-count growth is at least this (default 50).',
        ),
      monotonic_only: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Only consider classes that grew at EVERY step (default false: grew-net classes are included and flagged as noisy).',
        ),
      include_artifacts: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Include classes that are known measurement artifacts (CDP inspector retention, V8 JIT warmup, Blink a11y caches, captured Error stacks). Default false: they are counted in a one-line summary instead of consuming evidence slots, since none of them is an app leak.',
        ),
      baseline_run_dir: z
        .string()
        .optional()
        .describe(
          'An IDLE control round — the same app, driven by nothing. Its per-class per-cycle rate becomes a FLOOR: each row gets an "Above idle floor?" column and the table is ranked by EXCESS over idle rather than by absolute rate. Measured on one app, `system / Map` +2.83/cyc, `Array` +2.08, `system / Context / scope` +2.06, `(object elements)` +1.40 and `(enum cache)` +0.94 grow with ZERO interaction, and every driven round then listed those same classes as leak candidates. Only the first and last rung of the control are read (2 loads).',
        ),
      auto_baseline: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'With no explicit `baseline_run_dir`, look for a sibling run directory of `run_dir` whose name contains "idle" and use it as the control. A sweep names its idle round that way by convention, so the floor is subtracted without anyone remembering to ask. Set false to disable the search.',
        ),
      include_settle: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'When `run_dir` names a round that captured a settle rung, read it and add a `settled` column: how many instances of each growing class survived idle + GC. A class that DRAINS is in-flight backlog, not a leak, and its verdict hint is downgraded accordingly. Measured across one sweep, the settle rung retired 92,452 objects and 26.3 MB that the ladder alone reported as leaks. Costs one extra rung load; set false to skip it.',
        ),
      max_file_size_mb: z
        .number()
        .optional()
        .describe(
          'Per-file size ceiling in MB, matching memlab_load_snapshot / memlab_sequence_analysis defaults. Snapshots are loaded one at a time and dropped before the next.',
        ),
    },
    async (
      {
        run_dir,
        segment,
        paths,
        cycles,
        content,
        limit,
        min_growth_count,
        monotonic_only,
        include_artifacts,
        baseline_run_dir,
        auto_baseline,
        include_settle,
        max_file_size_mb,
      },
      extra,
    ) => {
      try {
        // Read the ladder + cycle axis from run.json when given; see
        // ../run-manifest.ts for why an assumed-even axis is unsafe.
        const cyclesArray = Array.isArray(cycles) ? cycles : undefined;
        const cyclesTotal = Array.isArray(cycles)
          ? cycles.length > 1
            ? cycles[cycles.length - 1] - cycles[0]
            : undefined
          : cycles;
        const inputs = resolveLadderInputs({
          run_dir,
          segment,
          paths,
          cycles: cyclesTotal,
          cycles_per_rung: cyclesArray,
        });
        paths = inputs.paths;
        cycles = inputs.cycles;
        // The runner measures the account it drove; asking the caller to
        // copy those counts back in meant they were almost never passed.
        const contentFromRun =
          content == null && inputs.manifest?.content != null;
        if (contentFromRun) content = inputs.manifest?.content ?? undefined;
        const ladderSpanS =
          inputs.spanSeconds ?? ladderSpanSeconds(inputs.manifest);
        const {steps, rows, cachedRungs} = await computeSequenceTrends(paths, {
          minGrowthCount: min_growth_count,
          monotonicOnly: monotonic_only,
          maxFileSizeMB: max_file_size_mb,
          toolName: 'memlab_leak_report',
          progress: makeProgressReporter(extra, 'leak_report'),
        });

        const n = steps.length;
        const artifactRows = rows.filter(r => r.artifact != null);
        const candidates: SequenceRow[] = (
          include_artifacts ? rows : rows.filter(r => r.artifact == null)
        ).slice(0, limit);

        const heapNet = steps[n - 1].totalSize - steps[0].totalSize;
        const lines: string[] = [
          `## Leak report (${n} snapshots)`,
          '',
          `Heap self-size ${heapNet >= 0 ? 'grew' : 'shrank'} by ${formatBytes(Math.abs(heapNet))} across the ladder (${formatNumber(steps[0].nodeCount)} → ${formatNumber(steps[n - 1].nodeCount)} nodes).`,
          '',
        ];
        const segmentNote = describeSegmentSelection(
          inputs.segment,
          inputs.manifest,
        );
        if (segmentNote != null) lines.push(segmentNote, '');
        if (n === 2) {
          lines.push(
            '> ⚠️ **Only 2 snapshots: "↑ every step" is monotonic by construction** and cannot separate a real trend from a single GC-band sample. Capture at least a third rung before treating anything here as a leak.',
            '',
          );
        }

        if (candidates.length === 0) {
          lines.push(
            `No non-artifact class grew by >= ${formatNumber(min_growth_count)} instances across the ladder — no unbounded-growth signal to report.`,
          );
          if (artifactRows.length > 0) {
            lines.push(
              '',
              `> 🧹 ${formatNumber(artifactRows.length)} growing class(es) were known measurement artifacts (pass \`include_artifacts: true\` to see them).`,
            );
          }
          return toolResult(
            capReportSize(lines.join('\n')),
            pathsHeader(steps.map(s => s.label)),
          );
        }

        // Evidence pass. The trend loop drops each graph before loading the
        // next, so the final rung is re-opened here — one extra load, and the
        // only way to ask retention questions about the classes the trend pass
        // just identified.
        const snapshot = await getFullHeapFromFile(steps[n - 1].localPath);
        const devRoots = collectDevRoots(snapshot);
        const reached =
          devRoots.byId.size > 0
            ? computeReachableWithoutDevRoots(snapshot, devRoots)
            : null;

        const evidence = new Map<string, Evidence>();
        for (const c of candidates) {
          evidence.set(c.key, {
            total: 0,
            devOnly: 0,
            devModule: 0,
            gatedModule: 0,
            provSampled: 0,
            devWhy: null,
            gatedWhy: null,
            samples: [],
            newest: [],
            example: null,
            exampleRetained: -1,
            anyExample: null,
          });
        }
        snapshot.nodes.forEach(node => {
          if (node.id <= 3) return;
          // Must key exactly as buildHistogram does, normalization included, or
          // per-instance Context/scope classes never match their trend row.
          const ev = evidence.get(
            `${node.type}::${normalizeClassName(node.name)}`,
          );
          if (!ev) return;
          ev.total++;
          if (reached != null && reached[node.nodeIndex] === 0) ev.devOnly++;
          if (ev.anyExample == null) ev.anyExample = node;
          if (!node.hasPathEdge) return;
          if (ev.samples.length < MAX_SAMPLES_PER_CLASS) ev.samples.push(node);
          // Keep the highest-id traceable instances — the class's newest, i.e.
          // the cohort the ladder's growth is made of. Insertion into a window
          // this small (8) is cheaper than sorting the class at the end.
          if (
            ev.newest.length < MAX_SAMPLES_PER_CLASS ||
            node.id > ev.newest[ev.newest.length - 1].id
          ) {
            let i = ev.newest.length;
            while (i > 0 && ev.newest[i - 1].id < node.id) i--;
            ev.newest.splice(i, 0, node);
            if (ev.newest.length > MAX_SAMPLES_PER_CLASS) ev.newest.pop();
          }
          if (node.retainedSize > ev.exampleRetained) {
            ev.exampleRetained = node.retainedSize;
            ev.example = node;
          }
        });
        // Provenance over the NEWEST instances, once the window is final.
        //
        // Doing it inside the walk sampled the first N nodes in traversal
        // order — the OLDEST of the class — while the retainer column
        // deliberately votes on the highest-id (newest) window. A class
        // mixing old dev-held instances with newly leaking ones was then
        // classified from the wrong half, in either direction. Both columns
        // now describe the same cohort.
        for (const ev of evidence.values()) {
          for (const node of ev.newest.slice(0, PROVENANCE_SAMPLES)) {
            ev.provSampled++;
            const prov = moduleProvenanceOf(node);
            // One reason PER CATEGORY. A single shared field took whichever
            // non-prod hit came first, so a class mixing both could render
            // "dev-only MODULE (<a gated reason>)" — the verdict from the
            // majority, the explanation from the minority.
            if (prov.prodReachable === 'no') {
              ev.devModule++;
              ev.devWhy = ev.devWhy ?? prov.why ?? prov.module;
            } else if (prov.prodReachable === 'gated') {
              ev.gatedModule++;
              ev.gatedWhy = ev.gatedWhy ?? prov.why ?? prov.module;
            }
          }
        }

        // The biggest traceable instance is the most informative one to walk, so
        // put it at the head of every retainer sample.
        for (const ev of evidence.values()) {
          if (ev.example != null) {
            ev.samples = [
              ev.example,
              ...ev.samples.filter(s => s.id !== (ev.example as IHeapNode).id),
            ];
          }
        }

        // The settle rung, when the round captured one.
        //
        // Without it every grower reads as a leak. Measured across one 20-round
        // sweep, the classes this column retires were 92,452 objects and
        // 26.3 MB — `WebLoomCore.completingTraces` went 26.3 MB / 148-of-149
        // terminal to ZERO, `{event,timestamp}` 53,029 to 1. A round that
        // skips this is not a round with one missing tool; it is a round whose
        // leak list is mostly backlog.
        // Existence-checked, in either form. A manifest can name a settle
        // rung that was later pruned or never finished writing, and reading
        // the path without checking turns that into an UNSETTLED banner on
        // a round that has no settle evidence at all — while `settleError`
        // suppresses every leak-candidate hint below it.
        const namedSettlePath =
          include_settle !== false
            ? (inputs.manifest?.settleRungPath ?? null)
            : null;
        const settlePath =
          namedSettlePath != null && fs.existsSync(namedSettlePath)
            ? namedSettlePath
            : null;
        const settleMissing = namedSettlePath != null && settlePath == null;
        let settledCounts: Map<string, number> | null = null;
        let settleError: string | null = null;
        if (settlePath != null) {
          try {
            // Through `resolveRungs`, not straight to `withSnapshotAt`: a
            // settle rung compressed by `memlab_prune_run` only resolves via
            // the snapshot-path resolver, and reading it directly reported a
            // pruned round as having no settle rung at all.
            const {rungs: settleRungs} = resolveRungs(
              [settlePath],
              max_file_size_mb,
            );
            // `resolveRungs` can return an empty list — a settle rung over
            // `max_file_size_mb` is the realistic case, and rungs here run
            // 358-526 MB. Indexing [0] then threw a TypeError that surfaced
            // as an opaque `settleError` instead of a sentence naming the
            // cap.
            if (settleRungs.length === 0) {
              throw new Error(
                `the settle rung at ${settlePath} did not resolve (commonly over \`max_file_size_mb\`)`,
              );
            }
            settledCounts = await withSnapshotAt(
              settleRungs[0].localPath,
              snap => {
                const {hist} = buildHistogram(snap);
                const out = new Map<string, number>();
                for (const [k, v] of hist) out.set(k, v.count);
                return out;
              },
            );
          } catch (e) {
            settleError = e instanceof Error ? e.message : String(e);
          }
        }
        /**
         * How much of a class's GROWTH survived idle + GC.
         *
         * Scored against the growth, not the total: a class with a large
         * standing population that was never part of the burst would otherwise
         * always read as "held".
         */
        const settleVerdict = (
          r: SequenceRow,
        ): {idle: number; kept: number | null; present: boolean} | null => {
          if (settledCounts == null) return null;
          const present = settledCounts.has(r.key);
          const idle = settledCounts.get(r.key) ?? 0;
          const base = r.counts[0];
          const grew = r.counts[r.counts.length - 1] - base;
          // CLAMPED to [0, 1]. The raw ratio is unbounded in both directions:
          // a settle-rung population larger than the ladder's growth renders
          // "400% held", and one below the baseline renders a negative that
          // then reads as drained for the wrong reason. Neither is a fraction
          // of the growth, which is what the column claims to be.
          // `grew <= 0` used to mean "fully held" unconditionally, which
          // says a class that ENDED at or below its baseline held all of a
          // growth it never had. There is nothing to score there; the caller
          // learns more from the absence of a number than from a 100%.
          if (grew <= 0) return {idle, kept: null, present};
          return {
            idle,
            kept: Math.max(0, Math.min(1, (idle - base) / grew)),
            present,
          };
        };
        const DRAIN_THRESHOLD = 0.1;

        // The IDLE floor.
        //
        // An idle control round establishes what this app allocates with no
        // interaction at all — on one app `system / Map` +2.83/cycle, `Array`
        // +2.08, `system / Context / scope` +2.06, `(object elements)` +1.40,
        // `(enum cache)` +0.94. Every driven round then listed those same
        // classes as `↑ every step — LEAK candidate`, and they were filtered
        // by eye, twenty times.
        const idleDir =
          baseline_run_dir ??
          (auto_baseline !== false && run_dir != null
            ? findIdleSibling(run_dir)
            : null);
        let idleRate: Map<string, number> | null = null;
        let idleLabel: string | null = null;
        let idleError: string | null = null;
        if (idleDir != null) {
          try {
            const control = resolveLadderInputs({run_dir: idleDir});
            const controlCycles =
              control.cycles != null && control.cycles > 0
                ? control.cycles
                : null;
            if (controlCycles == null) {
              throw new Error(
                'the control round records no cycle count, so it has no rate',
              );
            }
            // FIRST and LAST rung only. The floor is a rate, and two points
            // give one; loading a whole second ladder to refine a subtraction
            // would cost more than the report it is annotating.
            //
            // Two DISTINCT points. A one-rung control indexes the same path at
            // both ends, which compares a snapshot to itself: every delta is
            // 0, so the floor is 0 everywhere and the report says "idle floor
            // subtracted" having subtracted nothing. A floor that silently
            // reads 0 is worse than no floor — it certifies every grower.
            if (control.paths.length < 2) {
              throw new Error(
                `the control round has ${control.paths.length} rung(s); a rate needs two`,
              );
            }
            const ends = [
              control.paths[0],
              control.paths[control.paths.length - 1],
            ];
            const {rows: controlRows} = await computeSequenceTrends(ends, {
              minGrowthCount: 1,
              maxFileSizeMB: max_file_size_mb,
              toolName: 'memlab_leak_report (idle floor)',
            });
            idleRate = new Map(
              controlRows.map(r => [r.key, r.netCount / controlCycles]),
            );
            idleLabel = `${idleDir.replace(/\/$/, '').replace(/^.*\//, '')} (${formatNumber(controlCycles)} cycles)`;
          } catch (e) {
            idleError = e instanceof Error ? e.message : String(e);
          }
        }

        const perCycle = cycles != null && cycles > 0;
        const showDevOnly = reached != null;
        // Only when something was actually flagged: an all-`—` column on every
        // report is the cost of a check that usually finds nothing.
        const MIN_PROVENANCE_SAMPLE = 3;
        const isDevModuleOnly = (e: Evidence): boolean =>
          e.provSampled >= MIN_PROVENANCE_SAMPLE &&
          e.devModule + e.gatedModule >= DEV_ONLY_SHARE * e.provSampled;
        // The same rule the VERDICT uses, not "any sample hit at all". A
        // lone 1-of-8 hit is below the share and the minimum sample, so it
        // produces no verdict and no banner — but it still forced the
        // column onto every row of every report, which is the all-`—`
        // column this condition exists to avoid.
        const showDevModule = [...evidence.values()].some(isDevModuleOnly);
        const showSettled = settledCounts != null;
        const showIdleFloor = idleRate != null && perCycle;
        /** This class's per-cycle rate minus the idle control's. */
        const excessOverIdle = (r: SequenceRow): number | null => {
          if (!showIdleFloor || cycles == null) return null;
          return r.netCount / (cycles as number) - (idleRate?.get(r.key) ?? 0);
        };
        // Ranked by EXCESS, so the rows at the top are the ones the driving
        // caused. Absolute rate puts the idle floor first on every round.
        if (showIdleFloor) {
          candidates.sort(
            (a, b) => (excessOverIdle(b) ?? 0) - (excessOverIdle(a) ?? 0),
          );
        }
        const headers = [
          'Class',
          'Type',
          ...steps.map((_, i) => `#${i + 1}`),
          'Δ count',
          ...(perCycle ? ['Δ/cycle'] : []),
          'Δ size',
          ...(showDevOnly ? ['Dev-only'] : []),
          ...(showSettled ? ['Settled'] : []),
          ...(showDevModule ? ['Dev module'] : []),
          ...(showIdleFloor ? ['Above idle floor?'] : []),
          'Top retainer (newest instances)',
          'Verdict hint',
        ];
        const rightCols = new Set<number>();
        for (let i = 2; i < headers.length - 2; i++) rightCols.add(i);

        let leakCandidates = 0;
        let devOnlyClasses = 0;
        let drainedClasses = 0;
        let heldClasses = 0;
        /** HELD rows that are also leak candidates. See the tally below. */
        let heldCandidates = 0;
        // Rows the settle histogram does not mention at all. For one class
        // that is an ordinary full drain; for most of them it means the
        // settle rung is short — truncated, or written before the app
        // finished — and every "drained" verdict below rests on it.
        let absentFromSettle = 0;
        let settleRows = 0;
        let idleFloorClasses = 0;
        let devModuleClasses = 0;
        /** Of those, how many were driven by each category — the banner differs. */
        let devOnlyDriven = 0;
        let gatedDriven = 0;
        // Rows where the newest instances and the population at large are held
        // by different things. That disagreement is the signal a static
        // collection is masking the accumulating one, so it is reported rather
        // than resolved silently.
        const retainerSplits: string[] = [];
        const tableRows = candidates.map(r => {
          const ev = evidence.get(r.key) as Evidence;
          const devShare = ev.total > 0 ? ev.devOnly / ev.total : 0;
          const isDevOnly = showDevOnly && devShare >= DEV_ONLY_SHARE;
          if (isDevOnly) devOnlyClasses++;

          const settle = settleVerdict(r);
          // At least 80% NON-PRODUCTION — dev-only and flag-gated together.
          //
          // Counting only `devModule` let a class that is 8/8 GATED fall
          // through to `LEAK candidate` while the table beside it printed
          // `0/8 (+8 gated)`, which is the report contradicting itself. The
          // two carry different remedies but the same fact here: this is not
          // what a production user runs.
          //
          // 80%, and the same threshold the dev-ROOT column uses: a class can
          // legitimately mix a few devtools-held instances with real data. On
          // a small sample that is strict — 3 of 3 at `provSampled = 3` — so
          // it is stated as a share rather than described as a majority.
          const provSampled = ev.provSampled;
          // A MINIMUM sample, and unknowns count against the share.
          //
          // `provSampled` counts every instance walked, including the ones
          // `moduleProvenanceOf` could not attribute within its hop budget —
          // and those are already in the denominator, so they correctly
          // dilute rather than inflate. What was missing is a floor: at
          // provSampled = 1 a single hit is 100%, so one traceable instance
          // behind a devtools module suppressed the whole class as
          // non-production. Three is the smallest sample where the 80% share
          // means anything.
          const devModuleOnly = isDevModuleOnly(ev);
          // A TIE goes to gated, not dev-only. The two remedies are
          // opposite — dev-only says "must not be filed", gated says "real
          // leak, fix it" — so an even 4-dev / 4-gated split reported with
          // `>=` told the reader to drop a finding half the evidence says
          // to keep. Between two wrong answers, the one that keeps a real
          // leak on the list is the recoverable one.
          if (devModuleOnly) {
            devModuleClasses++;
            if (ev.devModule > ev.gatedModule) devOnlyDriven++;
            else gatedDriven++;
          }
          const excess = excessOverIdle(r);
          // "At the floor" means the driving added nothing this class was not
          // doing anyway. A 5% margin, because the two rounds are different
          // captures of the same app and an exact tie never happens.
          // The band is |excess| against the ABSOLUTE rate. Against the
          // signed rate it inverts for a shrinking class — a negative
          // tolerance no |excess| can be under — so such a row escapes both
          // floor bands and is re-published as a leak candidate.
          //
          // |excess|, not excess. The one-sided test is true for every row
          // whose excess is at most 5% of its rate — which includes rows
          // growing FAR SLOWER than idle (a large negative excess). Those
          // were labelled "at the idle floor — grows without interaction",
          // which is not what that verdict means, and were dropped from the
          // leak count on the strength of it.
          const atIdleFloor =
            excess != null &&
            cycles != null &&
            Math.abs(excess) <=
              0.05 * Math.abs(r.netCount / (cycles as number));
          // Outside the band on the LOW side: idle alone produces more of
          // this class than the driven round did. Without its own branch that
          // row falls through to `monotonic-up` and is published as a LEAK
          // candidate, which is the opposite of what the control showed.
          // `>= 0`, not `> 0`. A class with net zero and a positive idle
          // rate has an |excess| band of exactly 0 — nothing can sit inside
          // it — so it escaped `atIdleFloor` too and fell through to LEAK
          // candidate, while the control says idle alone produces MORE of it
          // than the driven round did.
          const belowIdleFloor =
            excess != null && !atIdleFloor && excess < 0 && r.netCount >= 0;
          if (atIdleFloor || belowIdleFloor) idleFloorClasses++;
          const drained =
            settle != null &&
            settle.kept != null &&
            settle.kept <= DRAIN_THRESHOLD &&
            r.netCount > 0;
          // HELD is settle evidence — "this did not come back" — and a NOISY
          // grower holds just as well as a monotonic one, so the split scores
          // every grower the settle rung could speak to.
          // `devModuleOnly` excluded too. The verdict chain drops those
          // rows before the candidate branch, so they could be counted as
          // HELD while never being counted as candidates — and the line
          // "of the N HELD, X are candidates — the rest grew net but not
          // at every step" then explained them with a reason that is not
          // theirs. Scored rows are now exactly the rows candidacy is
          // decided among.
          const scoredHeld =
            settle != null &&
            r.artifact == null &&
            !isDevOnly &&
            !devModuleOnly &&
            !drained;
          if (
            settle != null &&
            r.artifact == null &&
            !isDevOnly &&
            !devModuleOnly
          ) {
            settleRows++;
            if (!settle.present) absentFromSettle++;
            if (drained) drainedClasses++;
            else heldClasses++;
          }

          let verdict: string;
          if (r.artifact != null) {
            verdict = artifactLabel(r.artifact);
          } else if (isDevOnly) {
            verdict = '🛠 dev/automation-retained (not production)';
          } else if (devModuleOnly) {
            verdict =
              ev.devModule >= ev.gatedModule
                ? `🛠 dev-only MODULE (${ev.devWhy ?? 'not production'})`
                : `🛠 flag-gated MODULE (${ev.gatedWhy ?? 'off in production'})`;
          } else if (drained && settle != null && !settle.present) {
            // Absent from the settle histogram is still a drain — nothing of
            // the class survived — but it is a drain measured by ABSENCE,
            // and absence is also what a truncated settle rung produces.
            // Same classification, different word, so the reader can see
            // which evidence the verdict rests on. The round-level check
            // below catches the case where most rows read this way.
            verdict = '💧 absent from the settle rung — nothing survived';
          } else if (drained) {
            // A grower that drains is in-flight work. It must NOT carry the
            // "LEAK candidate" hint, which is the line that gets quoted.
            verdict = '💧 drained by settle — backlog, NOT a leak';
          } else if (atIdleFloor) {
            verdict = '⏸ at the idle floor — grows without interaction';
          } else if (belowIdleFloor) {
            verdict = '⏸ BELOW the idle floor — idle alone produces more';
          } else if (r.trend === 'monotonic-up') {
            // "LEAK candidate" is the line that gets quoted out of this
            // table, so it must not appear when the evidence that would
            // separate a leak from backlog was never read. The round-level
            // UNSETTLED banner below is not enough: nobody quotes the banner.
            verdict =
              settleError != null || settleMissing
                ? '↑ every step — UNSETTLED, the settle rung could not be read'
                : settle != null
                  ? '↑ every step AND survived settle — LEAK candidate'
                  : '↑ every step — LEAK candidate';
            if (settleError == null && !settleMissing) {
              leakCandidates++;
              // Counted HERE, in the branch that already survived every
              // exclusion above it, rather than re-testing the trend beside
              // the HELD tally. Restating the conditions in two places is
              // how the two numbers drift: a later exclusion added to this
              // chain — a dev-only module, an idle-floor row — would be
              // missed by the copy and the headline would claim more
              // candidates than the footer counts.
              if (scoredHeld) heldCandidates++;
            }
          } else {
            verdict = 'grew net (noisy)';
          }

          const label = displayName(r);
          return [
            label.length > 34 ? label.slice(0, 31) + '…' : label,
            r.type,
            ...r.counts.map(c => formatNumber(c)),
            `+${formatNumber(r.netCount)}`,
            ...(perCycle ? [(r.netCount / (cycles as number)).toFixed(2)] : []),
            `${r.netSize >= 0 ? '+' : ''}${formatBytes(r.netSize)}`,
            ...(showDevOnly
              ? [
                  ev.total === 0
                    ? '—'
                    : ev.devOnly === 0
                      ? '—'
                      : `${(devShare * 100).toFixed(0)}%`,
                ]
              : []),
            ...(showSettled && settle != null
              ? [
                  `${formatNumber(settle.idle)} (${
                    drained
                      ? 'drained'
                      : settle.kept == null
                        ? 'nothing grew'
                        : `${(settle.kept * 100).toFixed(0)}% held`
                  })`,
                ]
              : showSettled
                ? ['—']
                : []),
            ...(showDevModule
              ? [
                  // The NON-PROD share, which is what the verdict is
                  // derived from. Printing `devModule/provSampled` put a
                  // numerator that excludes gated over a denominator that
                  // includes it, so a fully gated class read `0/8 (+8
                  // gated)` — 0% — beside a non-production verdict.
                  provSampled === 0
                    ? '—'
                    : `${ev.devModule + ev.gatedModule}/${provSampled}${
                        ev.gatedModule > 0
                          ? ` (${ev.devModule} dev + ${ev.gatedModule} gated)`
                          : ''
                      }`,
                ]
              : []),
            ...(showIdleFloor
              ? [
                  excess == null
                    ? '—'
                    : `${excess >= 0 ? '+' : ''}${excess.toFixed(2)}/cyc (idle +${(idleRate?.get(r.key) ?? 0).toFixed(2)})`,
                ]
              : []),
            (() => {
              const g = growthRetainer(ev);
              if (g.populationLabel != null) {
                retainerSplits.push(
                  `\`${label}\`: newest → \`${clampLabel(g.label, 120)}\`, population at large → \`${clampLabel(g.populationLabel, 120)}\``,
                );
              }
              const shown =
                g.of > 1 ? `${g.label} (${g.votes}/${g.of})` : g.label;
              return shown.length > 44 ? shown.slice(0, 41) + '…' : shown;
            })(),
            verdict,
          ];
        });
        lines.push(markdownTable(headers, tableRows, rightCols));

        if (devModuleClasses > 0) {
          // Branched by CATEGORY, because the two remedies are opposite.
          // "They do not exist in a production build and must not be filed"
          // is true of a dev-only module and false of a flag-gated one — a
          // gated row IS production code behind a gate that is off, so the
          // leak is real and worth fixing. A gated-only report was printing
          // the dev-only banner and the dev-only footnote, telling the
          // reader to drop a finding they should have kept, and
          // `GATED_FOOTNOTE` was never emitted at all.
          if (devOnlyDriven > 0) {
            lines.push(
              '',
              `⚠ **${formatNumber(devOnlyDriven)} class(es) are reached only through a dev-only MODULE.** ` +
                'They do not exist in a production build and must not be filed. ' +
                'One sweep filed the same browser-tools interop population four separate times.',
              '',
              DEV_ONLY_FOOTNOTE,
            );
          }
          if (gatedDriven > 0) {
            lines.push(
              '',
              `⚠ **${formatNumber(gatedDriven)} class(es) are reached only through a FLAG-GATED module.** ` +
                'That code ships — the leak is real and worth fixing — but it runs behind a gate that is off for ' +
                'approximately all production traffic, so these bytes are not what a production user carries. ' +
                "Check the gate's pass rate before quoting the number as production impact.",
              '',
              GATED_FOOTNOTE,
            );
          }
        }

        if (cachedRungs.length > 0) {
          lines.push(
            '',
            `_${cachedRungs.length} of ${n} rung(s) were answered from a sidecar index (\`<snapshot>.memlab-index.json\`) instead of being re-parsed. The class table is unfiltered, so the numbers are the same either way. Force a re-parse with \`MEMLAB_NO_INDEX_CACHE=1\`._`,
          );
        }

        if (showIdleFloor) {
          lines.push(
            '',
            `**Idle floor subtracted** against \`${idleLabel}\`: rows are ranked by EXCESS over the control, ` +
              `not by absolute rate, and ${formatNumber(idleFloorClasses)} class(es) sit at or below the floor — they grow ` +
              'at least as fast with no interaction at all, so the driving did not cause them.',
          );
        } else if (idleError != null) {
          lines.push(
            '',
            `> ⚠️ The idle control at \`${idleDir}\` could not be read (${idleError}), so the rates below are absolute and include whatever this app allocates while doing nothing.`,
          );
        } else if (idleRate != null && !perCycle) {
          lines.push(
            '',
            '> ⚠️ An idle control was found but the cycle axis of THIS round is unknown, so there is no per-cycle rate to subtract it from. Pass `run_dir` or `cycles`.',
          );
        }

        // The settle line goes IMMEDIATELY under the table, in the fixed
        // "N HELD / M DRAINED" shape the digest lifts.
        if (showSettled) {
          lines.push(
            '',
            `**Settle: ${formatNumber(heldClasses)} class(es) HELD / ${formatNumber(drainedClasses)} DRAINED** ` +
              `(against \`${(settlePath as string).replace(/^.*\//, '')}\`). ` +
              'A DRAINED class returned to baseline after idle + GC: it was in-flight work, and reporting it ' +
              'as a leak is the single most common false positive this tool produces. ' +
              // One-directional, and with the candidate count beside it.
              // "Only the HELD rows are candidates" reads as "every HELD row
              // is a candidate", which is a different and false claim: HELD
              // scores the settle evidence over every grower, candidacy also
              // needs the trend. The two numbers disagreed on real output —
              // 6 HELD against 5 candidates on one measured round — and this
              // whole line is what the battery digest lifts.
              `No DRAINED row is a candidate; of the ${formatNumber(heldClasses)} HELD, ` +
              `**${formatNumber(heldCandidates)}** are candidates — the rest grew net but not at every step. ` +
              'Read the per-class detail with `memlab_settle_check`.',
          );
          // A class the settle histogram never mentions scores 0 and reads as
          // fully drained. One of those is ordinary. Most of them is a short
          // settle rung, and then every DRAINED verdict above is an artifact
          // of the file rather than a measurement of the app.
          if (settleRows >= 5 && absentFromSettle > settleRows / 2) {
            lines.push(
              '',
              `> ⚠️ **The settle rung may be short.** ${formatNumber(absentFromSettle)} of ${formatNumber(settleRows)} scored classes appear nowhere in it, ` +
                'which scores each of them as fully drained. That many at once is more consistent with a truncated capture than with the app releasing all of them. ' +
                'Check the rung opens and has a plausible node count before trusting the DRAINED rows.',
            );
          }
        } else if (settleMissing) {
          lines.push(
            '',
            `> ⚠️ **UNSETTLED — the settle rung is missing from disk.** The round records one at \`${namedSettlePath as string}\`, but the file is not there (pruned, or the capture was interrupted). Every row above is a grower of unknown kind. The round does not need re-driving if the file can be restored.`,
          );
        } else if (settleError != null) {
          lines.push(
            '',
            `> ⚠️ **UNSETTLED** — the round names a settle rung but it could not be read (${settleError}), so every row above is a grower of unknown kind. Nothing here separates retention from backlog.`,
          );
        } else if (include_settle !== false && inputs.manifest != null) {
          lines.push(
            '',
            '> ⚠️ **UNSETTLED — this round captured no settle rung**, so nothing below distinguishes a leak from ' +
              'in-flight backlog. A burst of activity legitimately inflates promise chains, scheduler queues and ' +
              'request buffers, and every one of those grows monotonically. Re-drive with the runner default ' +
              '(`--settle-minutes 7`) before recording any row here as a finding.',
          );
        }

        if (content != null && Object.keys(content).length > 0) {
          const hits: string[] = [];
          for (const r of candidates) {
            if (r.artifact != null) continue;
            for (const {key, per} of integerRatios(r.netCount, content)) {
              hits.push(
                `- \`${proseName(r)}\` grew by **${formatNumber(per)} per ${key}** ` +
                  `(${formatNumber(r.netCount)} / ${formatNumber(content[key])}).`,
              );
            }
          }
          if (contentFromRun) {
            lines.push(
              '',
              `_Content counts from run.json \`environment.content\`: ${Object.entries(
                content,
              )
                .map(([k, n]) => `${k} ${formatNumber(n)}`)
                .join(
                  ', ',
                )}${inputs.manifest?.viewport ? ` (viewport ${inputs.manifest.viewport})` : ''}` +
                (hits.length > 0
                  ? '._'
                  : '; no growing class grew by a whole number per unit of them._'),
            );
          }
          if (hits.length > 0) {
            lines.push(
              '',
              '### Growth that lands on a whole number per unit of content',
              '',
              ...hits,
              '',
              '_A clean integer ratio names the leaked UNIT, which a total cannot. It also changes the severity: ' +
                'a population that scales with the content the user already has grows with their data, not merely ' +
                'with how long they keep the tab open. Confirm by re-driving against an account with a different ' +
                'content count — the ratio should hold and the absolute number should not._',
            );
          }
        }

        // A LEAK-candidate verdict is the one most often read as "unbounded".
        // Over a ladder shorter than the app's retention window it is equally
        // consistent with a bounded working set — the exact reading that was
        // published and retracted. `ladder_probe` says this; this tool did not.
        if (leakCandidates > 0) {
          lines.push('', retentionWindowCaveat(ladderSpanS));
        }

        lines.push(
          '',
          '_"Top retainer" votes over the class\'s NEWEST instances (highest node ids — V8 allocates ids monotonically, so those are the growth cohort), not over its whole population. ' +
            'Voting over the population reports whoever holds the MOST instances, which is a large static collection whenever one exists, and is not what grew. ' +
            'It is a small sample of a heuristic cohort — confirm with `memlab_collection_trend` on the named collection before acting, since a retainer that is itself flat across the ladder contributed none of the growth._',
        );
        if (retainerSplits.length > 0) {
          lines.push(
            '',
            `⚠ **${retainerSplits.length} class(es) where the newest instances and the bulk population have DIFFERENT retainers.** ` +
              'That is the signature of a static collection sitting alongside an accumulating one; the newest-instance retainer is the one that grew:',
            ...retainerSplits.map(s => `- ${s}`),
          );
        }

        lines.push(
          '',
          `**${formatNumber(leakCandidates)} leak candidate(s)** of ${formatNumber(candidates.length)} growing class(es) examined` +
            (devModuleClasses > 0
              ? `; ${formatNumber(devModuleClasses)} ruled out as reached only through a non-production MODULE`
              : '') +
            (devOnlyClasses > 0
              ? `; ${formatNumber(devOnlyClasses)} ruled out as dev/automation-retained`
              : '') +
            (artifactRows.length > 0 && !include_artifacts
              ? `; ${formatNumber(artifactRows.length)} known measurement artifact(s) not shown (\`include_artifacts: true\`)`
              : '') +
            '.',
        );

        if (!showDevOnly) {
          lines.push(
            '',
            '_No dev/automation roots were found in the final snapshot, so the dev-only column is omitted — nothing here is being attributed to the inspector._',
          );
        }

        // Point at the single next call for the strongest candidate rather than
        // a menu: the failure mode this tool exists to fix is a plausible
        // grower being reported without anyone tracing it.
        // NOT a row the table just disowned. This filtered artifacts only,
        // so a report whose top row reads "dev-only MODULE — must not be
        // filed" still closed by telling the reader to retainer-trace it.
        const strongest = candidates.find(r => {
          const e = evidence.get(r.key);
          if (e == null || e.example == null) return false;
          if (r.artifact != null || r.trend !== 'monotonic-up') return false;
          if (isDevModuleOnly(e)) return false;
          const devShare = e.total > 0 ? e.devOnly / e.total : 0;
          return !(showDevOnly && devShare >= DEV_ONLY_SHARE);
        });
        if (strongest) {
          const ev = evidence.get(strongest.key) as Evidence;
          const example = ev.example as IHeapNode;
          // The argument values below want the RAW class name, not
          // proseName(): that one collapses whitespace, truncates with an
          // ellipsis and substitutes "(unnamed <type>)" for an empty name, all
          // of which are right for prose and produce a class name that matches
          // nothing when pasted into a tool call.
          //
          // But "raw" is unbounded — for a string-typed row it is the string's
          // value, and this line interpolates it TWICE. A 4 MB name therefore
          // added 8 MB to the report. Past the cap the literal is dropped
          // entirely rather than silently clipped: a clipped class name reads
          // as pasteable and matches nothing, which is the worse failure.
          const rawName = strongest.name;
          const pasteable = rawName.length <= PASTEABLE_NAME_MAX;
          const nameArg = pasteable
            ? JSON.stringify(rawName)
            : `"<the ${formatNumber(rawName.length)}-char class name — too long to inline; read it with memlab_get_node({node_id: ${example.id}})>"`;
          lines.push(
            '',
            `**Next:** confirm the top candidate before reporting it — \`memlab_retainer_trace({node_id: ${example.id}})\` on the largest traceable \`${proseName(strongest)}\` instance in the final rung, then \`memlab_dominator_chain\` on whatever owns it. Counts alone cannot distinguish a leak from a cache that grew and will be evicted.`,
            '',
            // Two tools that answer the questions a finding always ends on,
            // and that a multi-round sweep otherwise never reaches because
            // nothing in the flow names them.
            `Then, before it costs another round: \`memlab_finding_index({action: "check", retainer_path: "<the path the trace printed>", growing_classes: [${nameArg}]})\` says whether a previous round already found — or already FIXED — this exact path, and \`memlab_what_if({class_name: ${nameArg}})\` sizes what freeing the population would actually reclaim. "Is this new?" and "how much is it worth?" are the two questions a filing needs, and a retainer trace answers neither.`,
          );
        }

        return toolResult(
          capReportSize(lines.join('\n')),
          pathsHeader(steps.map(s => s.label)),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
