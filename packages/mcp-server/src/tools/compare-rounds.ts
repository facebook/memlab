/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * Compare N rounds of a sweep, and find the patterns no single round shows.
 *
 * The most valuable output of a twenty-round WhatsApp Web sweep was not in any
 * round's report. It was that React update chains landed on **exactly 1.000 or
 * 2.000 records per cycle per queue** — chain length equal to cycle count, to
 * the unit — on nine different surfaces, while `app_delta` was NEGATIVE in eight
 * of those same rounds. Both halves matter: a rate that lands on a whole number
 * names a MECHANISM (one record per interaction) rather than a trend, and a
 * population that grows while aggregate heap shrinks is invisible to the ladder
 * everyone actually looks at.
 *
 * That was found by pasting numbers out of twenty digests into a markdown table
 * by hand. Nothing in the toolkit compared rounds, so the finding was one
 * operator's diligence rather than a thing the tools produce.
 *
 * This reads the per-round outputs `memlab_analysis_battery` already wrote and
 * builds the matrix. It deliberately loads NO snapshots: comparing twenty rounds
 * must not mean re-reading eighty captures, and everything it needs is already
 * on disk as text.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import path from 'path';
import {z} from 'zod';
import {loadRunManifest} from '../run-manifest.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

interface RoundData {
  name: string;
  cycles: number;
  appDeltaMB: number | null;
  /** population -> per-cycle rate */
  rates: Map<string, number>;
  /** component -> longest pending chain */
  chains: Map<string, number>;
  missing: string[];
}

const MB = /([-+]?[\d.]+)\s*MB/;

function readIf(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** `**app_delta: +69.8 MB** — 80% of ...` -> 69.8 */
function parseAppDelta(text: string | null): number | null {
  if (text == null) return null;
  const line = text.split('\n').find(l => l.includes('app_delta'));
  if (line == null) return null;
  const m = MB.exec(line);
  return m ? Number(m[1]) : null;
}

/**
 * Per-class Δ/cycle out of a leak-report table.
 *
 * Parses the rendered table rather than a structured artifact because that is
 * what exists on disk. The column is located by HEADER rather than by index —
 * `leak_report` adds and drops columns (`Δ/cycle` only appears when cycles are
 * known, `Dev-only` only when something is dev-retained), so a fixed index reads
 * a different column on a different round, which is precisely the class of
 * silent error this whole stack is about.
 */
function parseLeakRates(text: string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (text == null) return out;
  const lines = text.split('\n').filter(l => l.trimStart().startsWith('|'));
  if (lines.length < 2) return out;
  const cells = (l: string): string[] =>
    l
      .split('|')
      .slice(1, -1)
      .map(c => c.trim());
  const header = cells(lines[0]);
  const classCol = header.findIndex(h => /^class$/i.test(h));
  const rateCol = header.findIndex(h => /Δ\/cycle/.test(h));
  if (classCol < 0 || rateCol < 0) return out;
  for (const line of lines.slice(1)) {
    const c = cells(line);
    if (c.length <= Math.max(classCol, rateCol)) continue;
    const name = c[classCol];
    const rate = Number(c[rateCol].replace(/[+,]/g, ''));
    if (name !== '' && !/^-+$/.test(name) && Number.isFinite(rate)) {
      out.set(name, rate);
    }
  }
  return out;
}

/** Component -> longest chain, out of a react_update_queues table. */
function parseChains(text: string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (text == null) return out;
  const lines = text.split('\n').filter(l => l.trimStart().startsWith('|'));
  if (lines.length < 2) return out;
  const cells = (l: string): string[] =>
    l
      .split('|')
      .slice(1, -1)
      .map(c => c.trim());
  const header = cells(lines[0]);
  const compCol = header.findIndex(h => /component/i.test(h));
  const chainCol = header.findIndex(h => /longest chain/i.test(h));
  if (compCol < 0 || chainCol < 0) return out;
  for (const line of lines.slice(1)) {
    const c = cells(line);
    if (c.length <= Math.max(compCol, chainCol)) continue;
    const n = Number(c[chainCol].replace(/,/g, ''));
    if (c[compCol] !== '' && !/^-+$/.test(c[compCol]) && Number.isFinite(n)) {
      out.set(c[compCol], n);
    }
  }
  return out;
}

/**
 * Is `x` a SMALL whole number — i.e. a plausible per-interaction unit rate?
 *
 * Both bounds are load-bearing, and the first version had neither right.
 *
 * The tolerance is ABSOLUTE. A relative tolerance scales with the value, so at
 * a rate of 1,077 it accepts anything within ±21 and "1077.18 ≈ 1077" gets
 * reported as a unit rate — which is not an insight, it is arithmetic. On real
 * sweep data that produced 19 flagged rows of pure noise and buried the one
 * that mattered.
 *
 * The magnitude cap is what makes the claim meaningful at all. "Exactly one
 * record per interaction" points at a single call site; "exactly 243 objects
 * per interaction" is a coincidence of rounding and says nothing about a
 * mechanism. Measured unit rates worth surfacing were 1.000, 2.010, 3.028 and
 * 5.026 — all small — while the noise sat at 12.95, 18.14, 25.62 and up.
 */
function nearWhole(x: number, tol = 0.03, maxMagnitude = 20): number | null {
  if (!Number.isFinite(x)) return null;
  const a = Math.abs(x);
  if (a < 1 - tol || a > maxMagnitude + tol) return null;
  const r = Math.round(a);
  return r >= 1 && Math.abs(a - r) <= tol ? r : null;
}

function readRound(dir: string): RoundData {
  const name = path.basename(dir.replace(/\/$/, ''));
  const manifest = loadRunManifest(dir);
  const a = path.join(dir.replace(/\/$/, ''), 'analysis');
  const budget = readIf(path.join(a, 'memlab_artifact_budget.txt'));
  const leak = readIf(path.join(a, 'memlab_leak_report.txt'));
  const queues = readIf(path.join(a, 'memlab_react_update_queues.txt'));
  const missing: string[] = [];
  if (budget == null) missing.push('artifact_budget');
  if (leak == null) missing.push('leak_report');
  if (queues == null) missing.push('react_update_queues');
  return {
    name,
    cycles: manifest.cycles,
    appDeltaMB: parseAppDelta(budget),
    rates: parseLeakRates(leak),
    chains: parseChains(queues),
    missing,
  };
}

export function registerCompareRounds(server: McpServer): void {
  server.tool(
    'memlab_compare_rounds',
    'Compare N rounds of a sweep and surface the patterns no single round shows.\n\n' +
      'Two of them are worth the call on their own. **A per-cycle rate that lands on a whole number names a MECHANISM** — a population accumulating exactly 1 or 2 per interaction is a different and much stronger finding than "it grew", and it is what turns a trend into a fix. **A population that grows while `app_delta` is NEGATIVE is invisible** to the aggregate ladder people actually look at; a measured sweep had eight such rounds, with chains reaching 9,818 records while the heap shrank.\n\n' +
      'That sweep found both by pasting twenty digests into a table by hand, because nothing compared rounds. This reads the per-round files `memlab_analysis_battery` already wrote and builds the matrix.\n\n' +
      'Loads NO snapshots — comparing twenty rounds must not mean re-reading eighty captures. It therefore requires each round to have been analysed first; a round with no `analysis/` directory is reported as such rather than silently omitted.',
    {
      run_dirs: z
        .array(z.string())
        .min(2)
        .describe(
          'Two or more leak-hunt round directories, each holding run.json and an analysis/ directory written by memlab_analysis_battery.',
        ),
      metric: z
        .enum(['classes', 'chains', 'both'])
        .optional()
        .default('both')
        .describe(
          '`classes` compares per-class Δ/cycle from leak_report; `chains` compares the longest React pending chain per component; `both` (default) does each in its own table.',
        ),
      min_rounds: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(2)
        .describe(
          'Only show a population present in at least this many rounds. A population seen once is a round result, not a sweep pattern.',
        ),
    },
    async ({run_dirs, metric, min_rounds}) => {
      try {
        const rounds: RoundData[] = [];
        const failed: string[] = [];
        for (const dir of run_dirs) {
          try {
            rounds.push(readRound(dir));
          } catch (e: unknown) {
            failed.push(
              `${dir}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        if (rounds.length < 2) {
          return errorResult(
            new Error(
              `only ${rounds.length} round(s) could be read; a comparison needs 2.\n` +
                failed.map(f => `- ${f}`).join('\n'),
            ),
          );
        }

        const lines: string[] = [
          `## Round comparison — ${rounds.length} rounds`,
          '',
          markdownTable(
            ['Round', 'Cycles', 'app_delta (MB)', 'Missing analysis'],
            rounds.map(r => [
              r.name,
              formatNumber(r.cycles),
              r.appDeltaMB == null ? '—' : r.appDeltaMB.toFixed(1),
              r.missing.length > 0 ? r.missing.join(', ') : '',
            ]),
            new Set([1, 2]),
          ),
          '',
        ];

        const unitRateNotes: string[] = [];
        const invisibleNotes: string[] = [];

        const buildMatrix = (
          title: string,
          pick: (r: RoundData) => Map<string, number>,
          unitLabel: string,
        ): void => {
          const names = new Set<string>();
          for (const r of rounds) for (const k of pick(r).keys()) names.add(k);
          const rows: string[][] = [];
          for (const n of [...names].sort()) {
            const present = rounds.filter(r => pick(r).has(n));
            if (present.length < min_rounds) continue;
            rows.push([
              n,
              ...rounds.map(r => {
                const v = pick(r).get(n);
                if (v == null) return '—';
                const whole = nearWhole(v);
                return whole != null ? `**${v.toFixed(2)}**` : v.toFixed(2);
              }),
            ]);
            for (const r of present) {
              const v = pick(r).get(n) as number;
              const whole = nearWhole(v);
              if (whole != null) {
                unitRateNotes.push(
                  `\`${n}\` in **${r.name}**: ${v.toFixed(3)} ≈ **${whole}** ${unitLabel}`,
                );
              }
              if (v > 0 && r.appDeltaMB != null && r.appDeltaMB < 0) {
                invisibleNotes.push(
                  `\`${n}\` grew in **${r.name}** while app_delta was ${r.appDeltaMB.toFixed(1)} MB`,
                );
              }
            }
          }
          if (rows.length === 0) return;
          lines.push(
            `### ${title}`,
            '',
            markdownTable(
              ['Population', ...rounds.map(r => r.name)],
              rows,
              new Set(rounds.map((_, i) => i + 1)),
            ),
            '',
          );
        };

        if (metric === 'classes' || metric === 'both') {
          buildMatrix('Per-class Δ/cycle', r => r.rates, 'per cycle');
        }
        if (metric === 'chains' || metric === 'both') {
          // A chain equal to the cycle count is the unit-rate signature in the
          // form it actually appeared: chain length == cycles driven.
          buildMatrix(
            'Longest React pending chain (records)',
            r => {
              const perCycle = new Map<string, number>();
              for (const [k, v] of r.chains) {
                if (r.cycles > 0) perCycle.set(k, v / r.cycles);
              }
              return perCycle;
            },
            'record(s) per cycle',
          );
        }

        if (unitRateNotes.length > 0) {
          lines.push(
            '### ⚑ Unit rates — a whole number names a MECHANISM',
            '',
            'A population accumulating exactly N per interaction is a much stronger finding than ' +
              '"it grew": it says one record is stranded per interaction, which points at a specific ' +
              'call site rather than at a trend.',
            '',
            ...[...new Set(unitRateNotes)].slice(0, 40).map(n => `- ${n}`),
            '',
          );
        }
        if (invisibleNotes.length > 0) {
          lines.push(
            '### ⚑ Invisible in aggregate heap',
            '',
            'These grew in a round whose `app_delta` was NEGATIVE. A post-GC ladder would have ' +
              'called those rounds clean — a measured sweep had eight of them, with chains reaching ' +
              '9,818 records while the heap shrank.',
            '',
            ...[...new Set(invisibleNotes)].slice(0, 40).map(n => `- ${n}`),
            '',
          );
        }

        const noAnalysis = rounds.filter(r => r.missing.length === 3);
        if (noAnalysis.length > 0) {
          lines.push(
            `_${noAnalysis.length} round(s) have no analysis output at all ` +
              `(${noAnalysis.map(r => r.name).join(', ')}). Run ` +
              '`memlab_analysis_battery({run_dir})` on them first — this tool reads what the ' +
              'battery writes and never loads a snapshot itself._',
            '',
          );
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
