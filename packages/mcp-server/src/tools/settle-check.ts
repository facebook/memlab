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
import path from 'path';
import {z} from 'zod';
import {getSnapshotByHandle} from '../heap-state.js';
import {withSnapshotAt} from '../snapshot-borrow.js';
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

/** Where the runner writes the settle rung (see hunt_runner.Runner.settle). */
const SETTLE_RUNG_BASENAME = 'rung_99_settle.heapsnapshot';

interface SettlePair {
  busyPath: string;
  settledPath: string;
  baselinePath: string | null;
}

/**
 * Resolve (last driven rung, settle rung, baseline rung) from a run directory.
 *
 * Returns a human-readable string on failure rather than throwing, because the
 * most common failure — the round has no settle rung — is not an error in the
 * caller, it is the finding: that round cannot tell a leak from a backlog and
 * must be recorded as UNSETTLED.
 */
function resolveSettlePair(runDir: string): SettlePair | string {
  const snapsDir = path.join(runDir, 'snapshots');
  const dir = fs.existsSync(snapsDir) ? snapsDir : runDir;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return `Cannot read ${dir}. Pass the run directory the hunt runner wrote (the one containing run.json).`;
  }
  const settled = entries.find(e => e === SETTLE_RUNG_BASENAME);
  if (settled == null) {
    return (
      `No settle rung (${SETTLE_RUNG_BASENAME}) in ${dir}.\n\n` +
      'That round was driven without one, so NOTHING in it distinguishes retention ' +
      'from in-flight backlog — two measured sweeps each published a large "leak" ' +
      'that idle then drained by ~99%. Record the round as UNSETTLED rather than as ' +
      'a leak, and re-drive with the runner default (--settle-minutes 7).'
    );
  }
  // Ordered by the NUMERIC rung index, not lexicographically. The runner
  // zero-pads to two digits, so a plain sort agrees with numeric order only
  // while the index stays under 100 — past that `rung_100` sorts before
  // `rung_99` and the wrong file is picked as busy or baseline, silently.
  const driven = entries
    .filter(e => /^rung_\d+_c\d+\.heapsnapshot$/.test(e))
    .map(e => ({name: e, idx: Number(/^rung_(\d+)_/.exec(e)?.[1])}))
    .sort((a, b) => a.idx - b.idx)
    .map(e => e.name);
  if (driven.length === 0) {
    return `No driven rungs (rung_NN_cNNN.heapsnapshot) in ${dir}.`;
  }
  return {
    busyPath: path.join(dir, driven[driven.length - 1]),
    settledPath: path.join(dir, settled),
    baselinePath: driven.length > 1 ? path.join(dir, driven[0]) : null,
  };
}

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
      run_dir: z
        .string()
        .optional()
        .describe(
          'A leak-hunt run directory. Resolves the last DRIVEN rung and the ' +
            'settle rung (rung_99_settle) from it and loads both transiently, ' +
            'so the common case needs no handles and no prior load. The runner ' +
            'writes that rung by default; a round whose run.json says ' +
            '"settled": false has no settle rung and cannot be adjudicated.',
        ),
      busy_handle: z
        .string()
        .optional()
        .describe(
          'Handle of the snapshot taken at peak activity (immediately after the interaction burst).',
        ),
      settled_handle: z
        .string()
        .optional()
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
      run_dir,
      busy_handle,
      settled_handle,
      baseline_handle,
      limit,
      min_growth,
    }) => {
      try {
        // run_dir is the ergonomic path: the runner already knows which rung is
        // the last driven one and which is the settle rung, so re-deriving that
        // by hand (and loading both with keep_previous) is pure ceremony that
        // an operator skips — and skipping the settle comparison is exactly how
        // a backlog gets published as a leak.
        // Only the per-class histograms are compared, so the run_dir path can
        // load each rung transiently and drop it. That matters: holding two
        // multi-gigabyte graphs resident is what forces an operator to raise
        // the old-space limit, and it is the reason this comparison was being
        // skipped in practice.
        let busyHist: Map<string, ClassStats>;
        let settledHist: Map<string, ClassStats>;
        let baseHist: Map<string, ClassStats> | null = null;
        let source: string;

        if (run_dir != null) {
          const pair = resolveSettlePair(run_dir);
          if (typeof pair === 'string') {
            return errorResult(new Error(pair));
          }
          busyHist = await withSnapshotAt(
            pair.busyPath,
            async (snap: IHeapSnapshot) => histogram(snap),
          );
          settledHist = await withSnapshotAt(
            pair.settledPath,
            async (snap: IHeapSnapshot) => histogram(snap),
          );
          if (pair.baselinePath != null) {
            baseHist = await withSnapshotAt(
              pair.baselinePath,
              async (snap: IHeapSnapshot) => histogram(snap),
            );
          }
          source =
            `run_dir ${run_dir}\n` +
            `busy   : ${path.basename(pair.busyPath)}\n` +
            `settled: ${path.basename(pair.settledPath)}` +
            (pair.baselinePath != null
              ? `\nbaseline: ${path.basename(pair.baselinePath)}`
              : '');
        } else {
          if (busy_handle == null || settled_handle == null) {
            return errorResult(
              new Error(
                'Pass either run_dir (recommended — it resolves the rungs for you), ' +
                  'or both busy_handle and settled_handle.',
              ),
            );
          }
          const busy = getSnapshotByHandle(busy_handle);
          const settled = getSnapshotByHandle(settled_handle);
          if (busy == null || settled == null) {
            const missing = [
              busy == null ? busy_handle : null,
              settled == null ? settled_handle : null,
            ].filter(Boolean);
            return errorResult(
              new Error(
                `Not resident: ${missing.join(', ')}. Load every rung with memlab_load_snapshot({keep_previous: true}), or pass run_dir and let this tool load them transiently.`,
              ),
            );
          }
          const baseline =
            baseline_handle != null
              ? getSnapshotByHandle(baseline_handle)
              : null;
          if (baseline_handle != null && baseline == null) {
            return errorResult(new Error(`Not resident: ${baseline_handle}.`));
          }
          busyHist = histogram(busy);
          settledHist = histogram(settled);
          baseHist = baseline != null ? histogram(baseline) : null;
          source = `handles ${busy_handle} -> ${settled_handle}`;
        }

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

        // Whether a baseline EXISTS, not whether the caller named one by
        // handle. `run_dir` resolves and loads a baseline rung itself, so
        // keying the verdict on `baseline_handle` threw away a 1.1 GB load
        // and reported the weaker "ranks reclamation, not leaks" wording on
        // the path that actually had the stronger evidence.
        const hasBaseline = baseHist != null;
        const baselineLabel = baseline_handle ?? "the run dir's baseline rung";

        if (rows.length === 0) {
          return toolResult(
            `No class grew by at least ${formatNumber(min_growth)} between ${hasBaseline ? baselineLabel : '(no baseline)'} and ${busy_handle ?? 'the last driven rung'}. Lower min_growth, or check that the rungs are in the right order (busy, then settled).`,
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
          source,
          `Heap self size ${formatBytes(busyTotal)} → ${formatBytes(settledTotal)} (${settledTotal <= busyTotal ? '−' : '+'}${formatBytes(Math.abs(busyTotal - settledTotal))} reclaimed by settling).`,
          '',
          !hasBaseline
            ? `**No baseline given, so this ranks reclamation, not leaks.** ${drained.length} class(es) came back almost entirely (in-flight work) and ${held.length} stayed — but "stayed" here includes every large standing population that was never part of the burst, because without a pre-activity rung there is no growth to measure the reclamation against. Supply one to turn this into a leak verdict: pass \`baseline_handle\`, or use a \`run_dir\` whose round has more than one driven rung (the first is taken as the baseline).`
            : held.length === 0
              ? '**Everything that grew came back.** No class survived idle + GC, so the growth in this round was in-flight work, not retention. There is nothing here to fix.'
              : `**${held.length} class(es) survived idle + GC** and ${drained.length} drained. Only the survivors are leak candidates — the drained ones were backlog and should not be reported as findings.`,
          '',
        ];

        const headers = hasBaseline
          ? ['Class', 'baseline', 'busy', 'settled', 'reclaimed', 'Verdict']
          : ['Class', 'busy', 'settled', 'reclaimed', 'Verdict'];
        const rightCols = hasBaseline
          ? new Set([1, 2, 3, 4])
          : new Set([1, 2, 3]);
        const tableRows = rows.slice(0, limit).map(r => {
          const [type, name] = r.key.split('::');
          const label = `${name} (${type})`;
          const cells = hasBaseline
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
          const note = hasBaseline
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
        if (held.length > 0 && hasBaseline) {
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
