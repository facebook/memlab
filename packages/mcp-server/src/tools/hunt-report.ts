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
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';

/**
 * Render a hunt's `run.json` into the report the skill prescribes.
 *
 * The report was assembled by hand every time, including re-deriving per-cycle
 * rates from the heartbeat log — which is both slow and the step where a caveat
 * quietly fails to make it into the writeup. Everything the report needs is
 * already in the manifest the runner writes; this is the mechanical half.
 *
 * The parts that matter most are the ones a hand-written report tends to drop:
 * the rung table with its per-cycle rate, the off-heap series (the documented
 * real OOM causes are invisible to a heap snapshot), and the caveats — an
 * under-seeded or under-fired run is still worth reporting, but only if it says
 * so.
 */
interface RunManifest {
  manifest_version?: number;
  run_id?: string;
  elapsed_s?: number;
  config?: Record<string, unknown>;
  totals?: {cycles?: number; ok?: number; fail?: number; batches?: number};
  rungs?: Array<{
    index: number;
    path: string;
    cycles: number;
    post_gc_heap_mb: number;
    elapsed_s: number;
    reason: string;
    screenshot?: string | null;
    off_heap?: Record<string, unknown>;
  }>;
  interaction_log?: Array<{i: number; combo: string; ok: boolean}>;
  caveats?: string[];
  stop_reason?: string;
}

function comboTable(log: Array<{combo: string; ok: boolean}>): string {
  const per = new Map<string, {ok: number; fail: number}>();
  for (const entry of log) {
    const e = per.get(entry.combo) ?? {ok: 0, fail: 0};
    if (entry.ok) e.ok++;
    else e.fail++;
    per.set(entry.combo, e);
  }
  if (per.size === 0) return '_No interaction log recorded._';
  return markdownTable(
    ['Combo', 'Landed', 'Missed', 'Land rate'],
    [...per.entries()].map(([name, v]) => {
      const total = v.ok + v.fail;
      return [
        name,
        formatNumber(v.ok),
        formatNumber(v.fail),
        total > 0 ? `${((v.ok / total) * 100).toFixed(0)}%` : '—',
      ];
    }),
    new Set([1, 2, 3]),
  );
}

export function registerHuntReport(server: McpServer): void {
  server.tool(
    'memlab_hunt_report',
    "Render a leak hunt's run.json into the prescribed report: configuration, the rung ladder with per-cycle rates, per-combo land rates, the off-heap series, caveats and the stop reason. " +
      'The report was hand-assembled on every round, including re-deriving per-cycle rates from the heartbeat log — slow, and the step where a caveat quietly fails to reach the writeup. An under-fired or under-seeded run is still worth reporting, but only if it says so, which is why caveats and land rates are rendered first-class rather than left to memory. ' +
      'Takes the manifest written by the hunt runner; pair with memlab_leak_report for the analysis half and memlab_finding_index to label each finding NEW or KNOWN.',
    {
      run_json: z
        .string()
        .describe('Path to the run.json written by the hunt runner.'),
      include_interaction_log: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Append the raw ordered interaction log (default false: the per-combo summary is what a reader acts on).',
        ),
    },
    async ({run_json, include_interaction_log}) => {
      try {
        if (!fs.existsSync(run_json)) {
          return errorResult(
            `No manifest at ${run_json}. The hunt runner writes run.json into its --outdir after every rung, so an aborted run still has one.`,
          );
        }
        let manifest: RunManifest;
        try {
          manifest = JSON.parse(
            fs.readFileSync(run_json, 'utf8'),
          ) as RunManifest;
        } catch (e) {
          return errorResult(
            `${run_json} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        const rungs = manifest.rungs ?? [];
        const totals = manifest.totals ?? {};
        const cycles = totals.cycles ?? 0;
        const elapsed = manifest.elapsed_s ?? 0;
        const cfg = manifest.config ?? {};

        const lines: string[] = [
          `# Leak hunt report — ${manifest.run_id ?? 'unnamed run'}`,
          '',
          '## 1. Configuration',
          '',
          markdownTable(
            ['Setting', 'Value'],
            Object.entries(cfg).map(([k, v]) => [
              k,
              Array.isArray(v) ? v.join(', ') : String(v ?? '—'),
            ]),
          ),
          '',
          '## 2. What was driven',
          '',
          `${formatNumber(cycles)} cycles in ${(elapsed / 60).toFixed(1)} min ` +
            `(${formatNumber(totals.ok ?? 0)} landed, ${formatNumber(totals.fail ?? 0)} missed` +
            `${cycles > 0 ? `, ${(elapsed / cycles).toFixed(2)}s/cycle` : ''}). ` +
            `Stopped because: **${manifest.stop_reason ?? 'unknown'}**.`,
          '',
          comboTable(manifest.interaction_log ?? []),
          '',
          '## 3. Rung ladder',
          '',
        ];

        if (rungs.length === 0) {
          lines.push('_No rungs captured — there is nothing to analyze._');
        } else {
          const first = rungs[0];
          const last = rungs[rungs.length - 1];
          lines.push(
            markdownTable(
              ['#', 'Cycles', 'Post-GC heap', 'Elapsed', 'Trigger', 'Snapshot'],
              rungs.map(r => [
                String(r.index),
                formatNumber(r.cycles),
                `${r.post_gc_heap_mb.toFixed(1)} MB`,
                `${(r.elapsed_s / 60).toFixed(1)} min`,
                r.reason,
                r.path.split('/').pop() ?? r.path,
              ]),
              new Set([1, 2, 3]),
            ),
            '',
          );
          const deltaMb = last.post_gc_heap_mb - first.post_gc_heap_mb;
          const deltaCycles = last.cycles - first.cycles;
          lines.push(
            `Post-GC heap moved **${deltaMb >= 0 ? '+' : ''}${deltaMb.toFixed(1)} MB** across ` +
              `${formatNumber(deltaCycles)} cycles` +
              (deltaCycles > 0
                ? ` (${((deltaMb * 1024) / deltaCycles).toFixed(1)} KB/cycle)`
                : '') +
              '.',
            '',
            '_Aggregate heap is context, not a verdict: a measured round found a real leak while this number FELL. Judge by the per-class trend from `memlab_leak_report`._',
            '',
          );
          if (rungs.length < 3) {
            lines.push(
              `> ⚠️ Only ${rungs.length} rung(s). With fewer than 3, "grew at every step" is not distinguishable from a single GC-band sample; treat any trend below as unconfirmed.`,
              '',
            );
          }

          const offHeapRows = rungs
            .filter(r => r.off_heap && Object.keys(r.off_heap).length > 0)
            .map(r => [
              String(r.index),
              String(r.off_heap?.storage_usage_mb ?? '—'),
              String(r.off_heap?.js_heap_mb ?? '—'),
              String(r.off_heap?.longtasks ?? '—'),
            ]);
          if (offHeapRows.length > 0) {
            lines.push(
              '## 4. Off-heap series',
              '',
              '_The documented real OOM causes — IndexedDB, decoded media, WASM — are invisible to a heap snapshot. These are sampled per rung so the blind spot is at least tracked._',
              '',
              markdownTable(
                ['Rung', 'Storage (MB)', 'JS heap (MB)', 'Longtasks'],
                offHeapRows,
                new Set([1, 2, 3]),
              ),
              '',
            );
          }
        }

        const caveats = manifest.caveats ?? [];
        lines.push('## 5. Caveats', '');
        if (caveats.length === 0) {
          lines.push('_None recorded._');
        } else {
          for (const c of caveats) lines.push(`- ⚠️ ${c}`);
          lines.push(
            '',
            '_Caveats are part of the finding, not a footnote: an under-fired or under-seeded run can look exactly like an app that does not leak._',
          );
        }

        if (include_interaction_log) {
          const log = manifest.interaction_log ?? [];
          lines.push(
            '',
            '## Appendix — interaction log',
            '',
            '```',
            ...log
              .slice(0, 200)
              .map(e => `${e.i}\t${e.combo}\t${e.ok ? 'ok' : 'miss'}`),
            log.length > 200 ? `… ${formatNumber(log.length - 200)} more` : '',
            '```',
          );
        }

        lines.push(
          '',
          '---',
          '',
          '**Next:** run `memlab_leak_report` over the rung paths above for the per-class trend, then `memlab_finding_index({action: "check"})` on each candidate before writing it up — a round that re-reports a known leak costs as much as one that finds nothing.',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
