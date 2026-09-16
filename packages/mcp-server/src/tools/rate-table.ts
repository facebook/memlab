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
import {z} from 'zod';
import path from 'path';
import {withSnapshotAt} from '../snapshot-borrow.js';
import {
  ladderSegments,
  loadRunManifest,
  type RunManifest,
} from '../run-manifest.js';
import {BUILTIN, countOne, type Metric} from './census.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

interface RoundRate {
  round: string;
  surface: string;
  cycles: number;
  first: number;
  last: number;
  perCycle: number | null;
  settle: number | null;
  /**
   * Whether the round's manifest HAS a settle rung — independent of whether
   * this call counted it. `settle == null` alone conflates "the round was
   * driven without one" with "the caller passed include_settle: false", and
   * only the first is worth telling the operator to re-drive for.
   */
  hasSettleRung: boolean;
  /** Why the settle rung could not be counted, when it exists but failed to load. */
  settleError: string | null;
  /**
   * Set when the round reloaded mid-ladder and only one isolate segment was
   * rated. Null for an ordinary single-isolate round.
   */
  segmentOf: string | null;
  isolateAgeMs: number | null;
  caveats: string[];
}

/**
 * What the round DROVE, which is the row label a rate table needs.
 *
 * The directory name is a round number and tells the reader nothing about
 * which surface produced the rate; `config.combos` is the only field that
 * does. Several combos in one round means the rate cannot be attributed to
 * any single surface, and saying so beats printing a number that looks
 * attributable.
 */
function surfaceOf(manifest: RunManifest): string {
  if (manifest.combos.length === 0) return '(combo not recorded)';
  if (manifest.combos.length === 1) return manifest.combos[0];
  return `${manifest.combos.join(' + ')} (MIXED — not attributable)`;
}

function resolveMetric(name: string): Metric {
  if (name.startsWith('class:')) {
    const cls = name.slice('class:'.length);
    return {
      name,
      describe: `Instances of class \`${cls}\`.`,
      needsProps: false,
      match: n => n.name === cls,
    };
  }
  const found = BUILTIN.find(m => m.name === name);
  if (found == null) {
    throw new Error(
      `unknown metric "${name}". Use one of: ${BUILTIN.map(m => m.name).join(
        ', ',
      )} — or "class:<ExactClassName>" to count a class by name.`,
    );
  }
  return found;
}

async function rateForRound(
  dir: string,
  metric: Metric,
  includeSettle: boolean,
): Promise<RoundRate> {
  const manifest = loadRunManifest(dir);
  // Rate the LAST isolate segment, never across a reload. Rungs either side of
  // a mid-ladder reload live in different V8 heaps, which is why every other
  // ladder tool here refuses to span one — differencing across a split
  // produced a 3.6 MB "shrink" where the valid segment read +2.1 MB. Rating
  // the whole run would have ranked such a number beside single-isolate
  // rounds with nothing on the row to say so.
  const segments = ladderSegments(manifest);
  const seg = segments[segments.length - 1];
  const split = segments.length > 1;
  const paths = split ? seg.paths : manifest.paths;
  const cyclesAxis = split ? seg.cyclesPerRung : manifest.cyclesPerRung;
  const first = paths[0];
  const last = paths[paths.length - 1];
  const firstCycles = cyclesAxis[0];
  const lastCycles = cyclesAxis[cyclesAxis.length - 1];

  const count = async (p: string): Promise<number> =>
    withSnapshotAt(p, s => countOne(s, [metric], []).get(metric.name) ?? 0);

  const firstCount = await count(first);
  const lastCount = first === last ? firstCount : await count(last);
  const driven = lastCycles - firstCycles;

  let settle: number | null = null;
  let settleError: string | null = null;
  if (includeSettle && manifest.settleRungPath != null) {
    // Isolated: the settle rung is an ENRICHMENT, and letting one unreadable
    // (missing / corrupt / oversized) settle snapshot throw would drop the
    // whole round from the ranking even though first, last and Δ/cycle were
    // already computed. Degrade to `settle = null` and say why.
    try {
      settle = await count(manifest.settleRungPath);
    } catch (err) {
      settleError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    round: path.basename(dir.replace(/\/+$/, '')) || dir,
    surface: surfaceOf(manifest),
    cycles: driven,
    first: firstCount,
    last: lastCount,
    perCycle: driven > 0 ? (lastCount - firstCount) / driven : null,
    settle,
    hasSettleRung: manifest.settleRungPath != null,
    settleError,
    // 0-BASED, matching `describeSegments` and the shared
    // SEGMENT_ARG_DESCRIPTION the other ladder tools accept. Printing a
    // 1-based ordinal here sent operators to a different segment when they
    // passed the number on to `segment:`.
    segmentOf: split
      ? `segment ${seg.index} of ${segments.length} (rungs ${seg.firstRung}-${seg.lastRung})`
      : null,
    isolateAgeMs: manifest.isolateAgeMsAtBaseline,
    caveats: manifest.caveats,
  };
}

export function registerRateTable(server: McpServer): void {
  server.tool(
    'memlab_rate_table',
    'Build the per-surface, per-cycle rate table for ONE metric across several rounds — the artifact that says which surface to fix first.\n\n' +
      'A sweep produces one rate per round, and a rate on its own is not decision-useful: `+44/cycle` means nothing until it sits beside a `+323/cycle` and an exact `0`. The ranking is the finding. In a measured eight-round sweep this table was the most decision-useful thing produced, and it was assembled by hand from eight separate digests because no tool emitted it.\n\n' +
      'Unlike `memlab_compare_rounds`, this LOADS snapshots (two per round, or three with the settle rung), so it works on rounds that were never run through `memlab_analysis_battery` — at the cost of load time. It also carries the two columns that decide whether the rates are comparable at all: the settle-rung count (a population that drains on idle was backlog, not a leak) and the isolate age at baseline (the same surface measured 2.6x apart on a fresh vs. saturated isolate).',
    {
      run_dirs: z
        .array(z.string())
        .min(1)
        .describe(
          'Leak-hunt round directories, each holding run.json. One is allowed but the table only becomes decision-useful at three or more.',
        ),
      metric: z
        .string()
        .describe(
          `Which population to rate. A built-in name (${BUILTIN.map(
            m => m.name,
          ).join(', ')}) or "class:<ExactClassName>" to count one class.`,
        ),
      include_settle: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Also count the settle rung where the round captured one (default true), so a population that drained on idle is visible as backlog rather than ranked as a leak.',
        ),
    },
    async ({run_dirs, metric, include_settle}) => {
      try {
        const m = resolveMetric(metric);
        const rows: RoundRate[] = [];
        const failed: string[] = [];
        for (const dir of run_dirs) {
          try {
            rows.push(await rateForRound(dir, m, include_settle));
          } catch (e: unknown) {
            failed.push(
              `${dir}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        if (rows.length === 0) {
          throw new Error(
            `no round could be read.\n${failed.map(f => `- ${f}`).join('\n')}`,
          );
        }

        // Descending by rate: the table exists to rank, and a round whose rate
        // could not be computed sorts last rather than reading as a zero.
        rows.sort(
          (a, b) => (b.perCycle ?? -Infinity) - (a.perCycle ?? -Infinity),
        );

        const anySettle = rows.some(r => r.settle != null);
        const anyAge = rows.some(r => r.isolateAgeMs != null);
        const header = [
          'surface',
          'round',
          'cycles',
          'first',
          'last',
          'Δ/cycle',
        ];
        if (anySettle) header.push('settle', 'drained');
        if (anyAge) header.push('isolate age');

        const body = rows.map(r => {
          const drained =
            r.settle != null && r.last > r.first
              ? `${(((r.last - r.settle) / (r.last - r.first)) * 100).toFixed(0)}%`
              : '—';
          const cells = [
            r.surface,
            r.round,
            formatNumber(r.cycles),
            formatNumber(r.first),
            formatNumber(r.last),
            r.perCycle == null ? '—' : r.perCycle.toFixed(2),
          ];
          if (anySettle) {
            cells.push(
              r.settle == null ? '—' : formatNumber(r.settle),
              drained,
            );
          }
          if (anyAge) {
            cells.push(
              r.isolateAgeMs == null
                ? '—'
                : `${(r.isolateAgeMs / 1000).toFixed(0)}s`,
            );
          }
          return cells;
        });

        const numeric = new Set<number>();
        for (let i = 2; i < header.length; i++) numeric.add(i);

        const lines = [
          `### \`${metric}\` — per-cycle rate by surface`,
          '',
          markdownTable(header, body, numeric),
          '',
        ];

        const splitRounds = rows.filter(r => r.segmentOf != null);
        if (splitRounds.length > 0) {
          lines.push(
            `⚠ **${splitRounds.length} round(s) reloaded mid-ladder**, so only the LAST isolate ` +
              `segment was rated (${splitRounds
                .map(r => `${r.round}: ${r.segmentOf}`)
                .join(
                  '; ',
                )}). Rungs either side of a reload are different V8 heaps and cannot be ` +
              'differenced; the rate shown covers fewer cycles than the round drove.',
            '',
          );
        }

        const unsettled = rows.filter(r => !r.hasSettleRung);
        if (unsettled.length > 0) {
          lines.push(
            `⚠ **${unsettled.length} round(s) captured no settle rung** (${unsettled
              .map(r => r.round)
              .join(', ')}). Their rates cannot distinguish retention from ` +
              'in-flight backlog, so they are not comparable with the settled rows above. ' +
              "Re-run with the runner's default settle rung, or treat those rates as upper bounds.",
            '',
          );
        }
        // Distinct from the above: these rounds DID capture a settle rung and
        // the caller asked not to count it. Telling them to re-drive would be
        // advice for a problem they do not have.
        const settleFailed = rows.filter(r => r.settleError != null);
        if (settleFailed.length > 0) {
          lines.push(
            `⚠ **${settleFailed.length} round(s) have a settle rung that FAILED TO LOAD** (${settleFailed
              .map(r => `${r.round}: ${r.settleError}`)
              .join(
                '; ',
              )}). Their Δ/cycle is still valid, but nothing here says whether that ` +
              'population drained on idle.',
            '',
          );
        }

        const uncounted = rows.filter(
          r => r.hasSettleRung && r.settle == null && r.settleError == null,
        );
        if (uncounted.length > 0) {
          lines.push(
            `_${uncounted.length} round(s) captured a settle rung that was NOT counted ` +
              '(`include_settle: false`); their Δ/cycle cannot be read as retention here. ' +
              'Re-run with `include_settle: true` to adjudicate them._',
            '',
          );
        }

        const drainers = rows.filter(
          r => r.settle != null && r.last > r.first && r.settle <= r.first,
        );
        if (drainers.length > 0) {
          lines.push(
            `**${drainers.length} round(s) drained back to baseline on idle** (${drainers
              .map(r => r.round)
              .join(
                ', ',
              )}). Those are BACKLOG, not leaks, whatever their Δ/cycle says — ` +
              'rank them out before choosing what to fix.',
            '',
          );
        }

        if (anyAge) {
          lines.push(
            '_Isolate age is how long the page had been live when the baseline rung was taken. ' +
              'It is here because the same surface measured +281.8 and +106.5 per cycle on a fresh ' +
              'vs. an already-driven isolate — a 2.6x spread with no code difference. Rank across ' +
              'rounds whose ages are comparable, or re-drive the outlier._',
            '',
          );
        }

        const withCaveats = rows.filter(r => r.caveats.length > 0);
        if (withCaveats.length > 0) {
          lines.push('### Round caveats', '');
          for (const r of withCaveats) {
            for (const c of r.caveats) lines.push(`- **${r.round}**: ${c}`);
          }
          lines.push('');
        }

        if (failed.length > 0) {
          lines.push('### Rounds that could not be read', '');
          for (const f of failed) lines.push(`- ${f}`);
        }

        return toolResult(lines.join('\n'));
      } catch (e: unknown) {
        return errorResult(e);
      }
    },
  );
}
