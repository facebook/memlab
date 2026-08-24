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
import type {IHeapNode} from '@memlab/core';
import {z} from 'zod';
import memlabHeapAnalysis from '@memlab/heap-analysis';
const {getFullHeapFromFile} = memlabHeapAnalysis;
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  pathsHeader,
  toolResult,
} from '../utils.js';
import {artifactLabel} from '../artifact-classes.js';
import {
  computeSequenceTrends,
  normalizeClassName,
  type SequenceRow,
} from './sequence-analysis.js';
import {
  collectDevRoots,
  computeReachableWithoutDevRoots,
} from './dev-artifacts.js';
import {getFirstNonFrameworkRetainer} from './detached-dom.js';
import {makeProgressReporter} from '../progress.js';

// Nodes kept per candidate class for the retainer sample. Small on purpose: the
// question is "what shape of thing holds these", and a handful of instances
// answers it — walking thousands would cost more than the trend pass itself.
const MAX_SAMPLES_PER_CLASS = 8;
const RETAINER_SAMPLES = 3;

// A class whose instances are overwhelmingly dev-root-retained is a measurement
// artifact in production terms, whatever its growth curve looks like. Matches
// the majority-not-any threshold intern_opportunities uses, for the same reason:
// a class can legitimately mix a few console-held instances with real data.
const DEV_ONLY_SHARE = 0.8;

interface Evidence {
  total: number;
  devOnly: number;
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
function displayName(row: {name: string; type: string}): string {
  return row.name.length > 0 ? row.name : `(unnamed ${row.type})`;
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
 * `tolerance` is fractional distance from the nearest integer >= 1.
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
    if (nearest >= 1 && Math.abs(ratio - nearest) <= tolerance * nearest) {
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
      'The verdict column is a HINT, not a conclusion — confirm a candidate with memlab_retainer_trace on the example node before calling it a leak. ' +
      "The retainer column votes over the class's NEWEST instances (highest node ids = the growth cohort), NOT over its whole population: voting over the population names whoever holds the most instances, which is a large STATIC collection whenever one exists and is not what grew. Rows where the two disagree are listed under the table. Paths may be local, manifold:// URLs, or bare filenames.",
    {
      paths: z
        .array(z.string())
        .min(1)
        .describe(
          'Ordered list of >=2 snapshot paths (oldest first): local absolute paths, manifold:// URLs, or bare snapshot filenames. A single ["ladder:<name>"] entry expands to a ladder saved with memlab_ladder.',
        ),
      cycles: z
        .number()
        .optional()
        .describe(
          'Number of interaction cycles driven between the FIRST and LAST snapshot. When provided, a "Δ/cycle" column is reported — a per-cycle rate is what says whether growth scales with interaction, which a total cannot.',
        ),
      content: z
        .record(z.number())
        .optional()
        .describe(
          'Counts of the CONTENT the driven surface contains — e.g. {"chats": 19, "messages": 40}. When given, each grower\'s net delta is also divided by these, and any ratio landing on a whole number is called out. This is what turns a number into a mechanism: a class growing by exactly one unit per chat is leaking a whole chat list per cycle, and scales with the user\'s data rather than with time.',
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
      max_file_size_mb: z
        .number()
        .optional()
        .describe(
          'Per-file size ceiling in MB, matching memlab_load_snapshot / memlab_sequence_analysis defaults. Snapshots are loaded one at a time and dropped before the next.',
        ),
    },
    async (
      {
        paths,
        cycles,
        content,
        limit,
        min_growth_count,
        monotonic_only,
        include_artifacts,
        max_file_size_mb,
      },
      extra,
    ) => {
      try {
        const {steps, rows} = await computeSequenceTrends(paths, {
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
            lines.join('\n'),
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

        const perCycle = cycles != null && cycles > 0;
        const showDevOnly = reached != null;
        const headers = [
          'Class',
          'Type',
          ...steps.map((_, i) => `#${i + 1}`),
          'Δ count',
          ...(perCycle ? ['Δ/cycle'] : []),
          'Δ size',
          ...(showDevOnly ? ['Dev-only'] : []),
          'Top retainer (newest instances)',
          'Verdict hint',
        ];
        const rightCols = new Set<number>();
        for (let i = 2; i < headers.length - 2; i++) rightCols.add(i);

        let leakCandidates = 0;
        let devOnlyClasses = 0;
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

          let verdict: string;
          if (r.artifact != null) {
            verdict = artifactLabel(r.artifact);
          } else if (isDevOnly) {
            verdict = '🛠 dev/automation-retained (not production)';
          } else if (r.trend === 'monotonic-up') {
            verdict = '↑ every step — LEAK candidate';
            leakCandidates++;
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
            (() => {
              const g = growthRetainer(ev);
              if (g.populationLabel != null) {
                retainerSplits.push(
                  `\`${label}\`: newest → \`${g.label}\`, population at large → \`${g.populationLabel}\``,
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

        if (content != null && Object.keys(content).length > 0) {
          const hits: string[] = [];
          for (const r of candidates) {
            if (r.artifact != null) continue;
            for (const {key, per} of integerRatios(r.netCount, content)) {
              hits.push(
                `- \`${displayName(r)}\` grew by **${formatNumber(per)} per ${key}** ` +
                  `(${formatNumber(r.netCount)} / ${formatNumber(content[key])}).`,
              );
            }
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
        const strongest = candidates.find(
          r =>
            r.artifact == null &&
            r.trend === 'monotonic-up' &&
            evidence.get(r.key)?.example != null,
        );
        if (strongest) {
          const ev = evidence.get(strongest.key) as Evidence;
          const example = ev.example as IHeapNode;
          lines.push(
            '',
            `**Next:** confirm the top candidate before reporting it — \`memlab_retainer_trace({node_id: ${example.id}})\` on the largest traceable \`${displayName(strongest)}\` instance in the final rung, then \`memlab_dominator_chain\` on whatever owns it. Counts alone cannot distinguish a leak from a cache that grew and will be evicted.`,
          );
        }

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
