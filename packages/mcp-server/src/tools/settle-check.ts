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
import {z} from 'zod';
import {getSnapshotByHandle} from '../heap-state.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';
import {normalizeClassName} from './sequence-analysis.js';

interface ClassStats {
  count: number;
  selfSize: number;
}

function histogram(snapshot: IHeapSnapshot): Map<string, ClassStats> {
  const hist = new Map<string, ClassStats>();
  snapshot.nodes.forEach(node => {
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
  return hist;
}

type Verdict = 'drained' | 'mostly-drained' | 'held' | 'still-growing';

function classify(base: number, busy: number, idle: number): Verdict {
  const grew = busy - base;
  if (grew <= 0) return idle > busy ? 'still-growing' : 'held';
  if (idle > busy) return 'still-growing';
  const retainedFraction = (idle - base) / grew;
  if (retainedFraction <= 0.1) return 'drained';
  if (retainedFraction <= 0.5) return 'mostly-drained';
  return 'held';
}

// Without a baseline the denominator is the whole population rather than the
// growth, so a large standing population that barely moves scores the same as
// a leak. The wording is graded accordingly: only the baseline-relative run
// gets to say "leak candidate".
const VERDICT_NOTE: Record<Verdict, string> = {
  drained: 'in-flight work — NOT a leak',
  'mostly-drained': 'mostly transient; small residue',
  held: 'survives idle + GC — leak candidate',
  'still-growing': 'grew further while idle — background accumulation',
};

const VERDICT_NOTE_NO_BASELINE: Record<Verdict, string> = {
  drained: 'almost entirely reclaimed by settling',
  'mostly-drained': 'largely reclaimed by settling',
  held: 'largely retained — cannot tell growth from standing population here',
  'still-growing': 'larger after idle than during the burst',
};

export function registerSettleCheck(server: McpServer): void {
  server.tool(
    'memlab_settle_check',
    'Separate RETENTION from in-flight BACKLOG by comparing a busy snapshot against one captured after the app settled (idle + forced GC). ' +
      'This is the measurement that a growth ladder alone cannot make: a burst of activity legitimately inflates promise chains, IndexedDB ' +
      'transactions, scheduler queues and request buffers, and every one of those looks exactly like a leak in a two-rung diff. Only a ' +
      'post-idle rung tells them apart — a class that returns to baseline was work in progress, a class that stays is retention.\n\n' +
      'Give it the busy rung and the settled rung (and optionally a pre-activity baseline, which makes the "how much of the growth came back" ' +
      'fraction meaningful rather than absolute). All snapshots must already be resident: load them with `keep_previous: true`.\n\n' +
      'Capture protocol for the settled rung: stop interacting, wait ~30-60s so timers, network callbacks and storage writes complete, force GC, then capture.',
    {
      busy_handle: z
        .string()
        .describe(
          'Handle of the snapshot taken at peak activity (immediately after the interaction burst).',
        ),
      settled_handle: z
        .string()
        .describe(
          'Handle of the snapshot taken after the app went idle and GC ran.',
        ),
      baseline_handle: z
        .string()
        .optional()
        .describe(
          'Optional handle of a pre-activity baseline. With it, each class is scored on how much of its GROWTH came back; without it, on how much of its total came back (a harsher and less meaningful test for classes with a large standing population).',
        ),
      limit: z
        .number()
        .optional()
        .default(25)
        .describe('Maximum classes to report (default 25).'),
      min_growth: z.number().optional().default(100),
    },
    async ({
      busy_handle,
      settled_handle,
      baseline_handle,
      limit,
      min_growth,
    }) => {
      try {
        const busy = getSnapshotByHandle(busy_handle);
        const settled = getSnapshotByHandle(settled_handle);
        if (busy == null || settled == null) {
          const missing = [
            busy == null ? busy_handle : null,
            settled == null ? settled_handle : null,
          ].filter(Boolean);
          return errorResult(
            new Error(
              `Not resident: ${missing.join(', ')}. Load every rung with memlab_load_snapshot({keep_previous: true}); this tool compares snapshots in memory rather than re-reading files.`,
            ),
          );
        }
        const baseline =
          baseline_handle != null ? getSnapshotByHandle(baseline_handle) : null;
        if (baseline_handle != null && baseline == null) {
          return errorResult(new Error(`Not resident: ${baseline_handle}.`));
        }

        const busyHist = histogram(busy);
        const settledHist = histogram(settled);
        const baseHist = baseline != null ? histogram(baseline) : null;

        const rows: Array<{
          key: string;
          base: number;
          busy: number;
          idle: number;
          verdict: Verdict;
          reclaimed: number;
        }> = [];

        for (const [key, busyStats] of busyHist) {
          const base = baseHist?.get(key)?.count ?? 0;
          const idle = settledHist.get(key)?.count ?? 0;
          const grew = busyStats.count - base;
          if (grew < min_growth) continue;
          rows.push({
            key,
            base,
            busy: busyStats.count,
            idle,
            verdict: classify(base, busyStats.count, idle),
            reclaimed: busyStats.count - idle,
          });
        }

        if (rows.length === 0) {
          return toolResult(
            `No class grew by at least ${formatNumber(min_growth)} between ${baseline_handle ?? '(no baseline)'} and ${busy_handle}. Lower min_growth, or check that the handles are in the right order (busy, then settled).`,
          );
        }

        rows.sort((a, b) => b.busy - b.idle - (a.busy - a.idle));
        const held = rows.filter(
          r => r.verdict === 'held' || r.verdict === 'still-growing',
        );
        const drained = rows.filter(r => r.verdict === 'drained');

        const busyTotal = totalSelfSize(busyHist);
        const settledTotal = totalSelfSize(settledHist);

        const lines: string[] = [
          '## Settle check',
          '',
          `Busy \`${busy_handle}\` → settled \`${settled_handle}\`${baseline_handle ? ` (baseline \`${baseline_handle}\`)` : ''}.`,
          `Heap self size ${formatBytes(busyTotal)} → ${formatBytes(settledTotal)} (${settledTotal <= busyTotal ? '−' : '+'}${formatBytes(Math.abs(busyTotal - settledTotal))} reclaimed by settling).`,
          '',
          baseline_handle == null
            ? `**No baseline given, so this ranks reclamation, not leaks.** ${drained.length} class(es) came back almost entirely (in-flight work) and ${held.length} stayed — but "stayed" here includes every large standing population that was never part of the burst, because without a pre-activity rung there is no growth to measure the reclamation against. Pass \`baseline_handle\` to turn this into a leak verdict.`
            : held.length === 0
              ? '**Everything that grew came back.** No class survived idle + GC, so the growth in this round was in-flight work, not retention. There is nothing here to fix.'
              : `**${held.length} class(es) survived idle + GC** and ${drained.length} drained. Only the survivors are leak candidates — the drained ones were backlog and should not be reported as findings.`,
          '',
        ];

        const headers = baseline_handle
          ? ['Class', 'baseline', 'busy', 'settled', 'reclaimed', 'Verdict']
          : ['Class', 'busy', 'settled', 'reclaimed', 'Verdict'];
        const rightCols = baseline_handle
          ? new Set([1, 2, 3, 4])
          : new Set([1, 2, 3]);
        const tableRows = rows.slice(0, limit).map(r => {
          const [type, name] = r.key.split('::');
          const label = `${name} (${type})`;
          const cells = baseline_handle
            ? [
                label,
                formatNumber(r.base),
                formatNumber(r.busy),
                formatNumber(r.idle),
                formatNumber(r.reclaimed),
              ]
            : [
                label,
                formatNumber(r.busy),
                formatNumber(r.idle),
                formatNumber(r.reclaimed),
              ];
          const note =
            baseline_handle != null
              ? VERDICT_NOTE[r.verdict]
              : VERDICT_NOTE_NO_BASELINE[r.verdict];
          return [...cells, `${r.verdict} — ${note}`];
        });
        lines.push(markdownTable(headers, tableRows, rightCols));

        if (rows.length > limit) {
          lines.push('', `_… and ${rows.length - limit} more; raise limit._`);
        }
        lines.push(
          '',
          '_A "drained" verdict is only as good as the settle: if the capture was taken before timers, network callbacks and storage writes finished, work still in flight will read as retention. Give it 30-60s of true idle and force GC first._',
        );
        if (held.length > 0 && baseline_handle != null) {
          lines.push(
            '',
            '**Next:** for each survivor, `memlab_retainer_trace` on an example instance in the settled snapshot — that is the trace worth putting in a fix.',
          );
        }
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

function totalSelfSize(hist: Map<string, ClassStats>): number {
  let total = 0;
  for (const s of hist.values()) total += s.selfSize;
  return total;
}
