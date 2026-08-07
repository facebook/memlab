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
const {getFullHeapFromFile} = memlabHeapAnalysis;
import {
  LOCAL_FILE_SIZE_LIMIT_MB,
  MANIFOLD_FETCH_SIZE_LIMIT_MB,
  resolveMaxFileSizeMB,
  resolveSnapshotPath,
} from './load-snapshot.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';
import {
  artifactLabel,
  artifactNote,
  classifyArtifact,
  type ArtifactKind,
} from '../artifact-classes.js';

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
function normalizeClassName(name: string): string {
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

export function registerSequenceAnalysis(server: McpServer): void {
  server.tool(
    'memlab_sequence_analysis',
    'Trend analysis across an ORDERED sequence of >=2 heap snapshots (the canonical "is anything growing unboundedly?" tool). Loads each snapshot transiently (does NOT change your active snapshot), builds per-class histograms, and reports each class\'s value at every step plus a growth verdict: "monotonic-up" (grew every step — strongest leak signal) vs "grew-net" (grew overall but not every step — often GC/navigation noise) vs flat/shrank. Also lists classes new since the baseline. Paths may be local, manifold:// URLs, or bare filenames.',
    {
      paths: z
        .array(z.string())
        .min(2)
        .describe(
          'Ordered list of >=2 snapshot paths (oldest first). Each may be a local absolute path, a manifold:// URL, or a bare snapshot filename.',
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
      include_artifacts: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Include classes that are known measurement artifacts (CDP inspector network/performance/console retention, V8 JIT warmup, Blink a11y caches, captured Error stacks). Default false: they are collapsed into a one-line summary instead of filling the table, because in practice they dominate the top of the list and none of them is an app leak.',
        ),
      max_file_size_mb: z
        .number()
        .optional()
        .describe(
          `Per-file size ceiling in MB to avoid OOM. Matches memlab_load_snapshot's by-source defaults — ${LOCAL_FILE_SIZE_LIMIT_MB} for local files and ${MANIFOLD_FETCH_SIZE_LIMIT_MB} for snapshots fetched from Manifold (server captures routinely exceed the local limit); pass an explicit value to override. Snapshots are loaded one at a time and dropped before the next, so a ladder of large files is safe as long as each single file is under the ceiling.`,
        ),
    },
    async ({
      paths,
      limit,
      min_growth_count,
      monotonic_only,
      include_artifacts,
      max_file_size_mb,
    }) => {
      try {
        const steps: Array<{
          label: string;
          hist: Map<string, ClassStats>;
          nodeCount: number;
          totalSize: number;
        }> = [];

        for (const p of paths) {
          let local: string;
          let fetchedFrom: string | null = null;
          try {
            const r = resolveSnapshotPath(p);
            local = r.localPath;
            fetchedFrom = r.fetchedFrom;
          } catch (e) {
            return errorResult(
              new Error(
                `Failed to resolve "${p}": ${e instanceof Error ? e.message : String(e)}`,
              ),
            );
          }
          if (!fs.existsSync(local)) {
            return errorResult(new Error(`File not found: ${local}`));
          }
          const sizeMB = fs.statSync(local).size / (1024 * 1024);
          const effectiveMaxFileSizeMB = resolveMaxFileSizeMB(
            max_file_size_mb,
            fetchedFrom != null,
          );
          if (sizeMB > effectiveMaxFileSizeMB) {
            return errorResult(
              new Error(
                `${p} is ${sizeMB.toFixed(0)} MB — exceeds the ${effectiveMaxFileSizeMB} MB per-file safety limit. ` +
                  `Raise it with memlab_sequence_analysis({max_file_size_mb: ${Math.ceil(sizeMB + 100)}}), ` +
                  `or restart the MCP server with more memory (NODE_OPTIONS="--max-old-space-size=8192") if it isn't already provisioned.`,
              ),
            );
          }
          // Load sequentially and drop the graph before the next one so only
          // one full graph is resident at a time (memory-safe for big heaps).
          const snapshot = await getFullHeapFromFile(local);
          const {hist, nodeCount, totalSize} = buildHistogram(snapshot);
          steps.push({
            label: fetchedFrom ?? p.replace(/^.*\//, ''),
            hist,
            nodeCount,
            totalSize,
          });
        }

        const n = steps.length;
        const first = steps[0].hist;
        const last = steps[n - 1].hist;

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

        interface Row {
          key: string;
          counts: number[];
          netCount: number;
          netSize: number;
          trend: Trend;
          artifact: ArtifactKind | null;
        }
        const rows: Row[] = [];
        for (const k of keys) {
          const counts = steps.map(s => s.hist.get(k)?.count ?? 0);
          const sizes = steps.map(s => s.hist.get(k)?.selfSize ?? 0);
          const netCount = counts[n - 1] - counts[0];
          const netSize = sizes[n - 1] - sizes[0];
          if (netCount < min_growth_count) continue;
          const trend = classifyTrend(counts);
          if (monotonic_only && trend !== 'monotonic-up') continue;
          if (trend !== 'monotonic-up' && trend !== 'grew-net') continue;
          const name = k.slice(k.indexOf('::') + 2);
          rows.push({
            key: k,
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
        const heapNet = steps[n - 1].totalSize - steps[0].totalSize;
        lines.push(
          '',
          `Overall heap self-size ${heapNet >= 0 ? 'grew' : 'shrank'} by ${formatBytes(Math.abs(heapNet))} across the sequence.`,
          '',
        );

        if (top.length === 0) {
          lines.push(
            `No classes grew by >= ${formatNumber(min_growth_count)} instances across the sequence. Heap looks flat-to-shrinking — no unbounded-growth signal.`,
          );
          return toolResult(lines.join('\n'));
        }

        lines.push('### Growing classes', '');
        const headers = [
          'Class',
          'Type',
          ...steps.map((_, i) => `#${i + 1}`),
          'Δ count',
          'Δ size',
          'Verdict',
        ];
        const rightCols = new Set<number>();
        for (let i = 2; i < headers.length - 1; i++) rightCols.add(i);
        const tableRows = top.map(r => {
          const sep = r.key.indexOf('::');
          const type = r.key.slice(0, sep);
          const name = r.key.slice(sep + 2);
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
          lines.push(
            '',
            '> ⚠️ `heap number` is growing. **This is only a capture artifact if you captured with numeric values ON** (`capture_numeric_value: true`), which emits one node per distinct number. If you captured with it **OFF** (the default), these are ordinary boxed doubles and the growth may be real — investigate with `memlab_retainer_summary` on `heap number` rather than dismissing it. Check which setting your capture used before deciding.',
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
            lines.push('', `> ${artifactNote(kind)}`);
          }
        }
        for (const kind of shownKinds) {
          lines.push('', `> ${artifactNote(kind)}`);
        }

        lines.push(
          '',
          '_"↑ every step (LEAK candidate)" is the strong unbounded-growth signal — it is a candidate, not a verdict: confirm with `memlab_dev_artifacts` and a `memlab_retainer_trace` before calling it a leak; "grew net (noisy)" often reflects GC timing or navigation and warrants a closer look before treating as a leak. Object-identity matching across snapshots is not available (node ids differ per capture) — to localize a specific growing collection, load the last snapshot and use `memlab_cache_analysis` / `memlab_event_listener_leaks` / `memlab_growth_signals`._',
        );

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
