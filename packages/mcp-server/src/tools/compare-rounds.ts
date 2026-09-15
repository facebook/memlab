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
  /** Analysis artifacts that are ABSENT — the all-missing test counts these. */
  missing: string[];
  /** Artifacts that exist but could not be read for what this tool needs. */
  notes: string[];
  /** How many analysis artifacts `readRound` looked for, for the all-missing test. */
  artifactCount: number;
}

/**
 * The number attached to `app_delta:`, in MB, whatever unit it was printed in.
 *
 * Anchored to the text right AFTER `app_delta:` and accepting every unit
 * `formatBytes` can emit. Matching the first `<n> MB` anywhere on the line read
 * the wrong number twice over: `artifact_budget` renders small rounds in B/KB
 * (`**app_delta: +386.5 KB — 10% of the +2.6 MB total**`), so the regex skipped
 * the delta and returned the TOTAL, and a line with no `MB` at all silently
 * became `—`.
 */
const APP_DELTA = /app_delta:\s*([-+]?[\d.]+)\s*(B|KB|MB|GB)\b/i;
const UNIT_MB: Record<string, number> = {
  b: 1 / (1024 * 1024),
  kb: 1 / 1024,
  mb: 1,
  gb: 1024,
};

/**
 * Both note lists are capped. Saying so matters: a sweep with more than
 * NOTE_LIMIT hits silently hid the remainder, which can include the one row the
 * tool exists to surface.
 */
const NOTE_LIMIT = 40;

function truncationNote(total: number): string[] {
  return total > NOTE_LIMIT ? [`- _…showing ${NOTE_LIMIT} of ${total}._`] : [];
}

function readIf(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** `**app_delta: +69.8 MB** — 80% of ...` -> 69.8 */
function parseAppDelta(text: string | null): number | null {
  if (text == null) return null;
  const line = text.split('\n').find(l => l.includes('app_delta'));
  if (line == null) return null;
  const m = APP_DELTA.exec(line);
  if (m == null) return null;
  const scale = UNIT_MB[m[2].toLowerCase()];
  return scale == null ? null : Number(m[1]) * scale;
}

/**
 * The row key has to mean the same thing in every round, and the rendered cell
 * text does not.
 *
 * `react_update_queues` appends ` ⚠` to a component whose walk hit the cap, and
 * `leak_report` truncates a class label to 34 chars with `…`. The same
 * component keyed as `Foo` in one round and `Foo ⚠` in the next split into two
 * rows, each present in half the rounds — and `min_rounds` then dropped both.
 */
function normalizePopulationKey(raw: string): string {
  return raw
    .replace(/\s*⚠\s*$/u, '')
    .replace(/…$/u, '')
    .trim();
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
    const name = normalizePopulationKey(c[classCol]);
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
    const comp = normalizePopulationKey(c[compCol]);
    if (comp !== '' && !/^-+$/.test(comp) && Number.isFinite(n)) {
      out.set(comp, n);
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
  // A NEGATIVE rate is not a unit rate. Rounding `Math.abs(x)` reported -1.00
  // as "≈ 1 per cycle" and bolded it in the matrix, dropping the sign that says
  // the population SHRANK — the opposite reading of the row.
  if (x < 0) return null;
  const a = Math.abs(x);
  if (a < 1 - tol || a > maxMagnitude + tol) return null;
  const r = Math.round(a);
  return r >= 1 && Math.abs(a - r) <= tol ? r : null;
}

function readRound(dir: string): RoundData {
  const name = path.basename(dir.replace(/\/$/, ''));
  const manifest = loadRunManifest(dir);
  const a = path.join(dir.replace(/\/$/, ''), 'analysis');
  const artifacts = [
    ['artifact_budget', 'memlab_artifact_budget.txt'],
    ['leak_report', 'memlab_leak_report.txt'],
    ['react_update_queues', 'memlab_react_update_queues.txt'],
  ] as const;
  const budget = readIf(path.join(a, artifacts[0][1]));
  const leak = readIf(path.join(a, artifacts[1][1]));
  const queues = readIf(path.join(a, artifacts[2][1]));
  const missing: string[] = [];
  if (budget == null) missing.push('artifact_budget');
  if (leak == null) missing.push('leak_report');
  if (queues == null) missing.push('react_update_queues');
  const rates = parseLeakRates(leak);
  // A round whose leak_report exists but carries no `Δ/cycle` column (the
  // column only appears when the cycle count is known) parses to an empty rate
  // map, and every class then renders `—` — indistinguishable from "that class
  // was absent". Recording it is what makes the un-analysable round visible,
  // which is the tool's stated contract.
  //
  // Kept OUT of `missing`, which counts artifacts that are ABSENT: the
  // all-missing test downstream is `missing.length >= artifactCount`, so
  // mixing a parse-quality note in let a round that produced one readable
  // artifact be reported as having no analysis output at all.
  const notes: string[] =
    leak != null && rates.size === 0
      ? ['leak_report has no Δ/cycle column']
      : [];
  return {
    name,
    artifactCount: artifacts.length,
    cycles: manifest.cycles,
    appDeltaMB: parseAppDelta(budget),
    rates,
    chains: parseChains(queues),
    missing,
    notes,
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
              [...r.missing, ...r.notes].join(', '),
            ]),
            new Set([1, 2]),
          ),
          '',
        ];

        const unitRateNotes: string[] = [];
        const invisibleNotes: string[] = [];

        const buildMatrix = (
          title: string,
          // Precomputed per round, NOT a callback. `pick(r)` was called once
          // per round to collect names and again inside the per-population
          // loops, so a derived map (the chains one builds a fresh Map every
          // call) was rebuilt roughly 3 x rounds x populations times.
          byRound: Map<RoundData, Map<string, number>>,
          unitLabel: string,
          // Whether a positive cell means the population GREW. True for a
          // Δ/cycle rate; false for the chains matrix, whose cells are
          // longest-chain-per-cycle and are positive whenever any pending chain
          // exists — so a stable chain was being reported as "grew".
          valueIsGrowthRate: boolean,
        ): void => {
          const empty = new Map<string, number>();
          const pick = (r: RoundData): Map<string, number> =>
            byRound.get(r) ?? empty;
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
              if (
                valueIsGrowthRate &&
                v > 0 &&
                r.appDeltaMB != null &&
                r.appDeltaMB < 0
              ) {
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
          const byRound = new Map(rounds.map(r => [r, r.rates]));
          buildMatrix('Per-class Δ/cycle', byRound, 'per cycle', true);
        }
        if (metric === 'chains' || metric === 'both') {
          // A chain equal to the cycle count is the unit-rate signature in the
          // form it actually appeared: chain length == cycles driven.
          //
          // Built once per round. The title says per-cycle because the cells
          // are `longest / cycles`; labelling it "(records)" put a different
          // number under the same name as the round's own react_update_queues
          // report.
          const byRound = new Map(
            rounds.map(r => {
              const perCycle = new Map<string, number>();
              if (r.cycles > 0) {
                for (const [k, v] of r.chains) perCycle.set(k, v / r.cycles);
              }
              return [r, perCycle] as const;
            }),
          );
          buildMatrix(
            'Longest React pending chain (records per cycle)',
            byRound,
            'record(s) per cycle',
            false,
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
            ...[...new Set(unitRateNotes)]
              .slice(0, NOTE_LIMIT)
              .map(n => `- ${n}`),
            ...truncationNote(new Set(unitRateNotes).size),
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
            ...[...new Set(invisibleNotes)]
              .slice(0, NOTE_LIMIT)
              .map(n => `- ${n}`),
            ...truncationNote(new Set(invisibleNotes).size),
            '',
          );
        }

        // Compared against the number of artifacts actually checked, not a
        // literal 3: adding a fourth artifact to `readRound` would otherwise
        // stop every analysis-less round from being reported as such.
        const noAnalysis = rounds.filter(
          r => r.missing.length >= r.artifactCount,
        );
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
