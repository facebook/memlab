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
    const key = `${node.type}::${node.name}`;
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
          rows.push({key: k, counts, netCount, netSize, trend});
        }
        // Monotonic growers first, then by net size delta.
        rows.sort((a, b) => {
          if (a.trend !== b.trend) return a.trend === 'monotonic-up' ? -1 : 1;
          return b.netSize - a.netSize;
        });
        const top = rows.slice(0, limit);

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
            r.trend === 'monotonic-up'
              ? '↑ every step (LEAK signal)'
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
              newClasses.push(`${k.slice(sep + 2)} (${formatNumber(c)})`);
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

        // "heap number" is V8's node for a captured numeric value. It only
        // appears when the snapshot was taken with numeric-value capture on
        // (Chrome's captureNumericValue / the browser MCP's capture_numeric_value
        // option). In that mode V8 emits one node per distinct number, which
        // both ~3x inflates the graph and shows up here as a top "↑ every step"
        // grower — a capture artifact, not a real leak. Flag it so it isn't
        // mistaken for the leak signal.
        if (top.some(r => r.key === 'number::heap number')) {
          lines.push(
            '',
            '> ⚠️ `heap number` is growing. This is almost always a **capture artifact** from taking snapshots with numeric-value capture enabled (one graph node per distinct number), not a real leak. Re-capture with numeric values OFF (browser MCP `capture_numeric_value: false`) for a ~3x smaller, faster, cleaner graph, and disregard `heap number` growth here.',
          );
        }

        lines.push(
          '',
          '_"↑ every step" is the strong unbounded-growth signal; "grew net (noisy)" often reflects GC timing or navigation and warrants a closer look before treating as a leak. Object-identity matching across snapshots is not available (node ids differ per capture) — to localize a specific growing collection, load the last snapshot and use `memlab_cache_analysis` / `memlab_event_listener_leaks` / `memlab_growth_signals`._',
        );

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
