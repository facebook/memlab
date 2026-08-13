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
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
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

function topRetainerLabel(ev: Evidence): string {
  const counts = new Map<string, number>();
  for (const node of ev.samples.slice(0, RETAINER_SAMPLES)) {
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
  return best;
}

export function registerLeakReport(server: McpServer): void {
  server.tool(
    'memlab_leak_report',
    'One-call leak triage across an ORDERED ladder of >=2 heap snapshots: runs the growth-trend pass, then gathers per-class EVIDENCE from the final snapshot and returns a single table — class, per-rung counts, Δ and Δ/cycle, how much of it is dev/automation-retained, the dominant retainer, and a verdict hint. ' +
      'Exists because the trend pass alone cannot tell a leak from an artifact: every hunt then ran memlab_dev_artifacts and a retainer trace by hand on each grower and joined the three outputs mentally, which is the step that gets skipped right before something is reported as a production leak. Composes memlab_sequence_analysis with memlab_dev_artifacts and a retainer sample; costs one extra snapshot load (the last rung) on top of the ladder pass. ' +
      'The verdict column is a HINT, not a conclusion — confirm a candidate with memlab_retainer_trace on the example node before calling it a leak. Paths may be local, manifold:// URLs, or bare filenames.',
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
    async ({
      paths,
      cycles,
      limit,
      min_growth_count,
      monotonic_only,
      include_artifacts,
      max_file_size_mb,
    }) => {
      try {
        const {steps, rows} = await computeSequenceTrends(paths, {
          minGrowthCount: min_growth_count,
          monotonicOnly: monotonic_only,
          maxFileSizeMB: max_file_size_mb,
          toolName: 'memlab_leak_report',
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
          return toolResult(lines.join('\n'));
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
          'Top retainer',
          'Verdict hint',
        ];
        const rightCols = new Set<number>();
        for (let i = 2; i < headers.length - 2; i++) rightCols.add(i);

        let leakCandidates = 0;
        let devOnlyClasses = 0;
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
            (label => (label.length > 44 ? label.slice(0, 41) + '…' : label))(
              topRetainerLabel(ev),
            ),
            verdict,
          ];
        });
        lines.push(markdownTable(headers, tableRows, rightCols));

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

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
