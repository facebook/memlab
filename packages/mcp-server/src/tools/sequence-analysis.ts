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
import type {IHeapSnapshot} from '@memlab/core';
import fs from 'fs';
import {z} from 'zod';
import memlabHeapAnalysis from '@memlab/heap-analysis';
import memlabCore from '@memlab/core';
const {utils: memlabUtils} = memlabCore;
const {getFullHeapFromFile} = memlabHeapAnalysis;
import {
  LOCAL_FILE_SIZE_LIMIT_MB,
  MANIFOLD_FETCH_SIZE_LIMIT_MB,
  resolveMaxFileSizeMB,
  resolveSnapshotPath,
} from './load-snapshot.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  pathsHeader,
  toolResult,
} from '../utils.js';
import {resolveLadderPaths} from './ladder.js';
import {makeProgressReporter} from '../progress.js';
import type {ProgressReporter} from '../progress.js';
import {findResidentByPath, getSnapshotByHandle} from '../heap-state.js';
import {resetEmittedNotes, shouldEmitNote} from '../heap-state.js';
import {
  artifactLabel,
  artifactNote,
  classifyArtifact,
  type ArtifactKind,
} from '../artifact-classes.js';
import {classifyNumericCapture, SMI_NUMBER_CLASS_KEY} from '../capture-mode.js';

interface ClassStats {
  count: number;
  selfSize: number;
}

// A class key is "<type>::<name>". Value-named string "classes" (literal
// values used as the name, e.g. "554", "1780525701808.81", "o:10,add") are
// noise across a sequence — drop them like diff_snapshots does (§10).
function isNoiseClass(type: string, name: string): boolean {
  if (type !== 'string' && type !== 'concatenated string') return false;
  if (name.length < 8) return true;
  if (/^[\s\d.,:+-]*$/.test(name)) return true;
  return false;
}

// V8 names per-instance Context/scope objects with a trailing " @<node-id>"
// (e.g. "system / Context / scope @706909"). Those ids differ per capture, so
// without normalization every scope is a distinct "class" that appears "new
// since baseline" and floods the report (observed: ~9,900 such keys, ~133k
// nodes, in a single Ads snapshot). Collapse the id so they aggregate into one
// comparable class across the sequence.
export function normalizeClassName(name: string): string {
  return name.replace(/ @\d+$/, ' @…');
}

function buildHistogram(snapshot: IHeapSnapshot): {
  hist: Map<string, ClassStats>;
  nodeCount: number;
  totalSize: number;
} {
  const hist = new Map<string, ClassStats>();
  let nodeCount = 0;
  let totalSize = 0;
  snapshot.nodes.forEach(node => {
    nodeCount++;
    totalSize += node.self_size;
    if (node.id <= 3) return;
    const key = `${node.type}::${normalizeClassName(node.name)}`;
    const e = hist.get(key);
    if (e) {
      e.count++;
      e.selfSize += node.self_size;
    } else {
      hist.set(key, {count: 1, selfSize: node.self_size});
    }
  });
  return {hist, nodeCount, totalSize};
}

type Trend = 'monotonic-up' | 'monotonic-down' | 'grew-net' | 'flat-or-mixed';

function classifyTrend(counts: number[]): Trend {
  let up = true;
  let down = true;
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] <= counts[i - 1]) up = false;
    if (counts[i] >= counts[i - 1]) down = false;
  }
  const net = counts[counts.length - 1] - counts[0];
  if (up && net > 0) return 'monotonic-up';
  if (down && net < 0) return 'monotonic-down';
  if (net > 0) return 'grew-net';
  return 'flat-or-mixed';
}

export interface SequenceStep {
  label: string;
  // Resolved local path, so a caller that needs the heap itself (not just the
  // histogram) can re-open a rung without re-resolving manifold:// URLs.
  localPath: string;
  hist: Map<string, ClassStats>;
  nodeCount: number;
  totalSize: number;
}

export interface SequenceRow {
  key: string;
  type: string;
  name: string;
  counts: number[];
  netCount: number;
  netSize: number;
  trend: Trend;
  artifact: ArtifactKind | null;
}

export interface SequenceTrends {
  steps: SequenceStep[];
  // Growing classes, filtered and sorted. Known artifacts are INCLUDED and
  // flagged via `artifact`; dropping them is a presentation choice each caller
  // makes for itself.
  rows: SequenceRow[];
  // Labels of the rungs served from an already-resident snapshot instead of a
  // fresh parse. Surfaced so a slow call and a fast one are distinguishable.
  reusedHandles: string[];
  // Union of non-noise class keys across all steps (for new-since-baseline).
  keys: Set<string>;
}

/**
 * Load an ordered ladder of snapshots and compute per-class growth trends.
 *
 * Extracted from the `memlab_sequence_analysis` handler so it can be composed
 * (see `memlab_leak_report`) instead of re-implemented: the loop that loads each
 * rung, histograms it, and drops the graph before the next is both the expensive
 * part and the part that is easy to get subtly wrong (resolution, size guard,
 * one-graph-resident-at-a-time).
 *
 * Failures THROW rather than returning an MCP error envelope — the callers are
 * tool handlers that already wrap their body in try/catch, and a composed caller
 * needs a failure it cannot accidentally treat as a result.
 */
export async function computeSequenceTrends(
  paths: string[],
  opts: {
    minGrowthCount: number;
    monotonicOnly?: boolean;
    maxFileSizeMB?: number;
    // Parse only, skipping the dominator / retained-size / shortest-path pass.
    // The trend itself needs nothing that pass produces (see the load below),
    // so it defaults ON; callers that go on to deep-dive a rung from the same
    // graph pass false.
    light?: boolean;
    // Named in the size-limit error so the remedy it prints is callable.
    toolName?: string;
    // Per-rung progress. A six-rung trend is minutes of silence otherwise, and
    // silence is indistinguishable from a hang — which is what pushed three
    // measured calls past the tool timeout into backgrounding.
    progress?: ProgressReporter;
  },
): Promise<SequenceTrends> {
  const toolName = opts.toolName ?? 'memlab_sequence_analysis';
  const steps: SequenceStep[] = [];
  const reusedHandles: string[] = [];
  // `paths: ["ladder:<name>"]` expands to a saved ladder (see ladder.ts), so a
  // six-rung trend call is one token instead of six absolute paths.
  const {paths: resolvedPaths} = resolveLadderPaths(paths);
  // The >=2 requirement is enforced here rather than in the schema: a ladder
  // reference is a SINGLE array element that expands to many, so a schema-level
  // `.min(2)` rejects `["ladder:name"]` before it can be expanded.
  if (resolvedPaths.length < 2) {
    throw new Error(
      `${toolName} needs at least 2 snapshots; got ${resolvedPaths.length}. ` +
        (paths.length === 1 && paths[0].startsWith('ladder:')
          ? 'That ladder has fewer than 2 rungs — check it with memlab_ladder({action:"show"}).'
          : 'Pass an ordered list of paths, or a single ["ladder:<name>"] reference.'),
    );
  }

  let rungIndex = 0;
  for (const p of resolvedPaths) {
    rungIndex++;
    opts.progress?.phase(
      rungIndex,
      resolvedPaths.length,
      `rung ${rungIndex}/${resolvedPaths.length}: ${p.replace(/^.*\//, '')}`,
    );
    let local: string;
    let fetchedFrom: string | null = null;
    try {
      const r = resolveSnapshotPath(p);
      local = r.localPath;
      fetchedFrom = r.fetchedFrom;
    } catch (e) {
      throw new Error(
        `Failed to resolve "${p}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!fs.existsSync(local)) {
      throw new Error(`File not found: ${local}`);
    }
    const sizeMB = fs.statSync(local).size / (1024 * 1024);
    const effectiveMaxFileSizeMB = resolveMaxFileSizeMB(
      opts.maxFileSizeMB,
      fetchedFrom != null,
    );
    if (sizeMB > effectiveMaxFileSizeMB) {
      throw new Error(
        `${p} is ${sizeMB.toFixed(0)} MB — exceeds the ${effectiveMaxFileSizeMB} MB per-file safety limit. ` +
          `Raise it with ${toolName}({max_file_size_mb: ${Math.ceil(sizeMB + 100)}}), ` +
          `or restart the MCP server with more memory (NODE_OPTIONS="--max-old-space-size=8192") if it isn't already provisioned.`,
      );
    }
    // Reuse a snapshot that is already resident rather than re-parsing it.
    // Parsing a 250 MB capture costs tens of seconds, and the common call
    // shape is a ladder whose rungs the caller already loaded to look at
    // individually — so the expensive step was being paid twice for no
    // difference in the result. Resident graphs are read-only here and the
    // active handle is never changed.
    const resident = findResidentByPath(local);
    const residentSnapshot =
      resident != null ? getSnapshotByHandle(resident.handle) : null;
    if (residentSnapshot != null)
      reusedHandles.push(resident?.fileName ?? local);
    // Otherwise load sequentially and drop the graph before the next one so
    // only one full graph is resident at a time (memory-safe for big heaps).
    // The trend pass reads counts, names, types and SELF sizes only —
    // `buildHistogram` touches nothing that the dominator / retained-size /
    // shortest-path pass produces. That pass is the expensive half of a load
    // (measured on a 380 MB / 4.19M-node capture: 18s vs 8s), and paying it on
    // five rungs to compute a histogram is most of why a six-rung report gets
    // backgrounded past the tool timeout. A resident graph is still reused
    // as-is, light or not.
    const useLight = opts.light !== false;
    const snapshot =
      residentSnapshot ??
      (useLight
        ? await memlabUtils.getSnapshotFromFile(local, {
            buildNodeIdIndex: true,
            verbose: false,
          })
        : await getFullHeapFromFile(local));
    const {hist, nodeCount, totalSize} = buildHistogram(snapshot);
    steps.push({
      label: fetchedFrom ?? p.replace(/^.*\//, ''),
      localPath: local,
      hist,
      nodeCount,
      totalSize,
    });
  }

  const n = steps.length;

  // Union of non-noise class keys.
  const keys = new Set<string>();
  for (const s of steps) {
    for (const k of s.hist.keys()) {
      const sep = k.indexOf('::');
      const type = k.slice(0, sep);
      const name = k.slice(sep + 2);
      if (!isNoiseClass(type, name)) keys.add(k);
    }
  }

  const rows: SequenceRow[] = [];
  for (const k of keys) {
    const counts = steps.map(s => s.hist.get(k)?.count ?? 0);
    const sizes = steps.map(s => s.hist.get(k)?.selfSize ?? 0);
    const netCount = counts[n - 1] - counts[0];
    const netSize = sizes[n - 1] - sizes[0];
    if (netCount < opts.minGrowthCount) continue;
    const trend = classifyTrend(counts);
    if (opts.monotonicOnly && trend !== 'monotonic-up') continue;
    if (trend !== 'monotonic-up' && trend !== 'grew-net') continue;
    const sep = k.indexOf('::');
    const name = k.slice(sep + 2);
    rows.push({
      key: k,
      type: k.slice(0, sep),
      name,
      counts,
      netCount,
      netSize,
      trend,
      artifact: classifyArtifact(name),
    });
  }
  // Real growers first: genuine classes ahead of known artifacts, then
  // monotonic ahead of noisy, then by net size delta.
  rows.sort((a, b) => {
    const aArt = a.artifact != null;
    const bArt = b.artifact != null;
    if (aArt !== bArt) return aArt ? 1 : -1;
    if (a.trend !== b.trend) return a.trend === 'monotonic-up' ? -1 : 1;
    return b.netSize - a.netSize;
  });

  return {steps, rows, keys, reusedHandles};
}

/**
 * Artifact-family explanations are long and identical on every call. Print the
 * full note once per session and a one-line pointer afterwards; the COUNTS that
 * accompany it are per-call data and are always shown by the caller.
 */
function pushArtifactNote(lines: string[], kind: ArtifactKind): void {
  if (shouldEmitNote(`artifact:${kind}`)) {
    lines.push('', `> ${artifactNote(kind)}`);
  } else {
    lines.push(
      '',
      `> ${artifactLabel(kind)} — explained earlier this session.`,
    );
  }
}

export function registerSequenceAnalysis(server: McpServer): void {
  server.tool(
    'memlab_sequence_analysis',
    'Trend analysis across an ORDERED sequence of >=2 heap snapshots (the canonical "is anything growing unboundedly?" tool). Loads each snapshot transiently (does NOT change your active snapshot), builds per-class histograms, and reports each class\'s value at every step plus a growth verdict: "monotonic-up" (grew every step — strongest leak signal) vs "grew-net" (grew overall but not every step — often GC/navigation noise) vs flat/shrank. Also lists classes new since the baseline. Paths may be local, manifold:// URLs, or bare filenames.',
    {
      paths: z
        .array(z.string())
        .min(1)
        .describe(
          'Ordered list of >=2 snapshot paths (oldest first): local absolute paths, manifold:// URLs, or bare snapshot filenames. A single ["ladder:<name>"] entry expands to a ladder saved with memlab_ladder.',
        ),
      limit: z
        .number()
        .optional()
        .default(25)
        .describe('Maximum number of growing classes to report (default 25).'),
      min_growth_count: z
        .number()
        .optional()
        .default(50)
        .describe(
          'Only report classes whose net instance-count growth is at least this (default 50).',
        ),
      monotonic_only: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Report only classes that grew at EVERY step (default false: include grew-net too, flagged).',
        ),
      cycles: z
        .number()
        .optional()
        .describe(
          'Number of interaction cycles driven between the FIRST and LAST snapshot. When provided, a "Δ/cycle" column is reported. A per-cycle rate — not a total — is what tells you whether growth scales with interaction, and it is the number a leak hunt actually reasons about.',
        ),
      include_artifacts: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Include classes that are known measurement artifacts (CDP inspector network/performance/console retention, V8 JIT warmup, Blink a11y caches, captured Error stacks). Default false: they are collapsed into a one-line summary instead of filling the table, because in practice they dominate the top of the list and none of them is an app leak.',
        ),
      repeat_notes: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Re-print the standing explanatory notes (artifact-family write-ups, capture-mode caveats, the "candidate, not verdict" paragraph) that are otherwise emitted once per server session. The per-call DATA — which classes grew, how many artifacts were suppressed — is always shown; only the unchanging prose is deduplicated.',
        ),
      max_file_size_mb: z
        .number()
        .optional()
        .describe(
          `Per-file size ceiling in MB to avoid OOM. Matches memlab_load_snapshot's by-source defaults — ${LOCAL_FILE_SIZE_LIMIT_MB} for local files and ${MANIFOLD_FETCH_SIZE_LIMIT_MB} for snapshots fetched from Manifold (server captures routinely exceed the local limit); pass an explicit value to override. Snapshots are loaded one at a time and dropped before the next, so a ladder of large files is safe as long as each single file is under the ceiling.`,
        ),
    },
    async (
      {
        paths,
        limit,
        min_growth_count,
        monotonic_only,
        cycles,
        include_artifacts,
        repeat_notes,
        max_file_size_mb,
      },
      extra,
    ) => {
      try {
        if (repeat_notes) resetEmittedNotes();
        const {steps, rows, keys, reusedHandles} = await computeSequenceTrends(
          paths,
          {
            minGrowthCount: min_growth_count,
            monotonicOnly: monotonic_only,
            maxFileSizeMB: max_file_size_mb,
            progress: makeProgressReporter(extra, 'sequence_analysis'),
          },
        );

        const n = steps.length;
        const first = steps[0].hist;
        const last = steps[n - 1].hist;

        // Known artifacts dominate the top of this table in practice and none
        // of them is an app leak, so by default they are summarized rather than
        // listed. They are still counted, and `include_artifacts` brings them
        // back — suppression must never be silent.
        const artifactRows = rows.filter(r => r.artifact != null);
        const candidateRows = include_artifacts
          ? rows
          : rows.filter(r => r.artifact == null);
        const top = candidateRows.slice(0, limit);

        const lines: string[] = [
          `## Sequence / Trend Analysis (${n} snapshots)`,
          '',
        ];

        // Per-step heap totals.
        const totalHeaders = ['Step', 'Snapshot', 'Nodes', 'Heap (self)'];
        const totalRows = steps.map((s, i) => [
          String(i + 1),
          s.label.length > 40 ? '…' + s.label.slice(-39) : s.label,
          formatNumber(s.nodeCount),
          formatBytes(s.totalSize),
        ]);
        lines.push(markdownTable(totalHeaders, totalRows, new Set([2, 3])));
        if (reusedHandles.length > 0) {
          lines.push(
            '',
            `_${reusedHandles.length} of ${n} rung(s) were served from a snapshot already resident in this session rather than re-parsed._`,
          );
        }
        const heapNet = steps[n - 1].totalSize - steps[0].totalSize;
        lines.push(
          '',
          `Overall heap self-size ${heapNet >= 0 ? 'grew' : 'shrank'} by ${formatBytes(Math.abs(heapNet))} across the sequence.`,
          '',
        );

        // With exactly two rungs "grew at every step" is the same statement as
        // "grew overall", so the monotonic verdict carries no extra information
        // and cannot distinguish a trend from a GC-band sample. Measured case: a
        // 2-rung ladder read as a confident +154 KB/cycle retained leak, and a
        // third and fourth rung showed the heap falling back below where it
        // started — the band was ~25 MB wide, easily enough to fake a linear
        // slope. Say so rather than letting the label imply a trend.
        if (n === 2) {
          lines.push(
            '> ⚠️ **Only 2 snapshots: "↑ every step" is monotonic by construction** and cannot separate a real trend from a single GC-band sample. Capture at least a third rung (and prefer a targeted-retainer count over aggregate heap) before treating anything here as a leak.',
            '',
          );
        }

        if (top.length === 0) {
          lines.push(
            `No classes grew by >= ${formatNumber(min_growth_count)} instances across the sequence. Heap looks flat-to-shrinking — no unbounded-growth signal.`,
          );
          return toolResult(
            lines.join('\n'),
            pathsHeader(steps.map(s => s.label)),
          );
        }

        lines.push('### Growing classes', '');
        const perCycle = cycles != null && cycles > 0;
        const headers = [
          'Class',
          'Type',
          ...steps.map((_, i) => `#${i + 1}`),
          'Δ count',
          ...(perCycle ? ['Δ/cycle'] : []),
          'Δ size',
          'Verdict',
        ];
        const rightCols = new Set<number>();
        for (let i = 2; i < headers.length - 1; i++) rightCols.add(i);
        const tableRows = top.map(r => {
          const {type, name} = r;
          const verdict =
            r.artifact != null
              ? artifactLabel(r.artifact)
              : r.trend === 'monotonic-up'
                ? '↑ every step (LEAK candidate)'
                : 'grew net (noisy)';
          return [
            name.length > 36 ? name.slice(0, 33) + '…' : name,
            type,
            ...r.counts.map(c => formatNumber(c)),
            `+${formatNumber(r.netCount)}`,
            ...(perCycle ? [(r.netCount / (cycles as number)).toFixed(2)] : []),
            `${r.netSize >= 0 ? '+' : ''}${formatBytes(r.netSize)}`,
            verdict,
          ];
        });
        lines.push(markdownTable(headers, tableRows, rightCols));

        // New-since-baseline classes (absent at step 1, present at step N).
        const newClasses: string[] = [];
        for (const k of keys) {
          if (!first.has(k) && last.has(k)) {
            const c = last.get(k)?.count ?? 0;
            if (c >= min_growth_count) {
              const sep = k.indexOf('::');
              const name = k.slice(sep + 2);
              // Don't clutter the list with known JIT/automation artifacts.
              if (classifyArtifact(name) != null) continue;
              newClasses.push(`${name} (${formatNumber(c)})`);
            }
          }
        }
        if (newClasses.length > 0) {
          lines.push(
            '',
            '### New since baseline',
            '',
            newClasses.slice(0, 20).join(', ') +
              (newClasses.length > 20
                ? `, … +${newClasses.length - 20} more`
                : ''),
          );
        }

        // `heap number` growth is a capture artifact when the snapshot was
        // taken with numeric-value capture on (Chrome's captureNumericValue /
        // the browser MCP's capture_numeric_value): that mode emits one graph
        // node per distinct number and ~3x inflates the graph. With it off,
        // these are ordinary boxed doubles that V8 allocates anyway, and growth
        // can be a REAL signal.
        //
        // We deliberately do NOT try to auto-detect which mode produced the
        // snapshot. The obvious signal — value-named nodes of type `number` —
        // does not separate the two: a snapshot captured with
        // capture_numeric_value:false was measured with 47,874 `heap number`
        // nodes AND 165,193 value-named numeric nodes, so any threshold on that
        // count mislabels it. Stating a conditional the caller can resolve from
        // their own capture settings beats asserting a mode we cannot verify;
        // the previous copy declared this "almost always a capture artifact"
        // unconditionally, which trains readers to dismiss a grower that may be
        // real.
        if (top.some(r => r.key === 'number::heap number')) {
          // State the answer instead of asking the caller for it. The runtime
          // and the numeric-capture mode are both derivable from the histograms
          // already built above, at no extra cost: `smi number` is the marker
          // node type, and a `Window …` class means a browser capture. See
          // capture-mode.ts for the matched-pair measurements behind this.
          const last = steps[n - 1].hist;
          const isBrowser = [...last.keys()].some(k =>
            k.startsWith('object::Window '),
          );
          const isNode =
            !isBrowser && [...last.keys()].some(k => k === 'object::Module');
          const verdict = classifyNumericCapture(
            isBrowser ? 'browser' : isNode ? 'node' : 'unknown',
            last.has(SMI_NUMBER_CLASS_KEY),
          );
          lines.push(
            '',
            shouldEmitNote('seq:heap-number')
              ? `> ⚠️ \`heap number\` is growing. ${verdict.note}`
              : '> ⚠️ `heap number` is growing (capture-mode caveat already stated this session).',
          );
        }
        // `smi number` growth in a Node capture is pure capture overhead — those
        // nodes do not exist unless the flag asked for them.
        if (
          top.some(r => r.key === SMI_NUMBER_CLASS_KEY) &&
          ![...steps[n - 1].hist.keys()].some(k =>
            k.startsWith('object::Window '),
          )
        ) {
          lines.push(
            '',
            shouldEmitNote('seq:smi-number')
              ? '> ⚠️ `smi number` is growing in a Node.js capture. Those nodes only exist because the snapshot was taken with numeric-value capture ON; they are capture overhead, not application memory. Re-capture without it to remove them from the trend.'
              : '> ⚠️ `smi number` is growing — capture overhead (note already stated this session).',
          );
        }

        // Known-artifact families: either annotate the rows that were shown,
        // or account for the ones that were collapsed. Either way the caller is
        // told what was set aside and why.
        const shownKinds = new Set<ArtifactKind>();
        for (const r of top) if (r.artifact != null) shownKinds.add(r.artifact);
        const suppressedByKind = new Map<ArtifactKind, number>();
        if (!include_artifacts) {
          for (const r of artifactRows) {
            suppressedByKind.set(
              r.artifact as ArtifactKind,
              (suppressedByKind.get(r.artifact as ArtifactKind) ?? 0) + 1,
            );
          }
        }
        if (suppressedByKind.size > 0) {
          const parts = [...suppressedByKind.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([kind, count]) => `${kind} ${count}`);
          lines.push(
            '',
            `> 🧹 **${artifactRows.length} growing class(es) suppressed as known measurement artifacts** (${parts.join(', ')}). None of these families is an application leak; pass \`include_artifacts: true\` to see them.`,
          );
          for (const kind of suppressedByKind.keys()) {
            pushArtifactNote(lines, kind);
          }
        }
        for (const kind of shownKinds) {
          pushArtifactNote(lines, kind);
        }

        if (shouldEmitNote('seq:candidate-not-verdict')) {
          lines.push(
            '',
            '_"↑ every step (LEAK candidate)" is the strong unbounded-growth signal — it is a candidate, not a verdict: confirm with `memlab_dev_artifacts` and a `memlab_retainer_trace` before calling it a leak; "grew net (noisy)" often reflects GC timing or navigation and warrants a closer look before treating as a leak. Object-identity matching across snapshots is not available (node ids differ per capture) — to localize a specific growing collection, load the last snapshot and use `memlab_cache_analysis` / `memlab_event_listener_leaks` / `memlab_growth_signals`._',
          );
        } else {
          lines.push(
            '',
            '_"↑ every step" is a candidate, not a verdict — see the first `memlab_sequence_analysis` result this session for the full caveat, or pass `repeat_notes: true`._',
          );
        }

        // A ladder driven under load cannot distinguish retention from work in
        // flight: a burst legitimately inflates promise chains, IDB
        // transactions, scheduler queues and request buffers, and every one of
        // those climbs at every step exactly like a leak. The check that
        // separates them is a rung captured after the app settles, and it is
        // the step most often skipped — so the absence of one is called out
        // here rather than left for the reader to remember.
        lines.push(
          '',
          '⏳ **No settle rung.** Every growth figure above was measured while the app was active, so in-flight work is indistinguishable from retention here. Capture one more snapshot after ~30-60s idle with a forced GC and run `memlab_settle_check(busy_handle, settled_handle)`: classes that return to baseline were backlog, not leaks.',
        );

        return toolResult(
          lines.join('\n'),
          pathsHeader(steps.map(s => s.label)),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
