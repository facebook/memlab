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
import fs from 'fs';
import path from 'path';
import {auditManifest} from './round-audit.js';
import {rungMetricsSection} from '../rung-metrics.js';
import {
  errorResult,
  toolResult,
  formatNumber,
  markdownTable,
} from '../utils.js';

/**
 * The subset of a run's own record that decides whether its numbers can be
 * quoted. Deliberately duplicated rather than imported: `round-audit`'s copy is
 * the input to its adjudication, and widening that type to serve a second
 * reader would couple the two.
 */
interface RunManifest {
  run_id?: string;
  config?: {combos?: string[]; target_cycles?: number};
  totals?: {cycles?: number; ok?: number; fail?: number};
  rungs?: Array<{
    index?: number;
    path?: string;
    cycles?: number;
    post_gc_heap_mb?: number;
    isolate_restarted?: boolean;
  }>;
  steps?: Record<
    string,
    {attempted?: number; landed?: number; errors?: number; rate?: number}
  >;
  ladder_splits_after_rung?: number[];
  mutates_content_per_cycle?: string[];
  gating_verified?: Record<string, unknown>;
  caveats?: string[];
  stop_reason?: string;
}

/** `run.json`, whether given the file or the directory holding it. */
function resolveManifestPath(input: string): string | null {
  let p = input;
  try {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      p = path.join(p, 'run.json');
    }
  } catch {
    return null;
  }
  return fs.existsSync(p) ? p : null;
}

/**
 * The verdict rows of an analysis file.
 *
 * `memlab_analyze_run` writes markdown for a human, and the shape that carries
 * the verdict is its per-class trend table:
 *
 *   | Class | Type | Δ count | Δ/cycle | Δ size | Adjudication |
 *
 * Parsed structurally — split on `|`, then find the column that holds an
 * adjudication — rather than by one big regex over the whole row. The first
 * version of this WAS one big regex, written against a hand-made example
 * rather than real output, and it matched nothing at all on the first genuine
 * analysis file: 48 table lines skipped, zero rows. It failed safe (it said so)
 * but it was useless, which is the same thing from the caller's side.
 */
interface MetricRow {
  metric: string;
  delta: string;
  rate: string;
  size: string;
  verdict: string;
}

/** Words `analyze_run` uses in an adjudication cell. */
const VERDICT_RE =
  /LEAK CANDIDATE|LEAK|STEP FUNCTION|LINEAR|FLAT|ARTIFACT|NOISE|SHRANK|BOUNDED|NOT A LEAK|CANDIDATE|↑|↓/i;

/** Split a markdown row into trimmed cells, dropping the empty outer pair. */
function cells(line: string): string[] {
  const parts = line.split('|').map(c => c.trim());
  if (parts.length > 0 && parts[0] === '') parts.shift();
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function parseAnalysis(text: string): {rows: MetricRow[]; skipped: number} {
  const rows: MetricRow[] = [];
  let skipped = 0;
  let header: string[] | null = null;
  let verdictCol = -1;

  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('|')) {
      // A blank line or prose ends the current table, so a header cannot leak
      // into the next one.
      if (trimmed === '') {
        header = null;
        verdictCol = -1;
      }
      continue;
    }
    if (/^\s*\|[\s:|-]+\|?\s*$/.test(line)) continue; // separator
    const cs = cells(line);
    if (cs.length < 2) continue;

    if (header == null) {
      header = cs.map(c => c.toLowerCase());
      verdictCol = header.findIndex(
        h => h.includes('adjudication') || h.includes('verdict'),
      );
      continue;
    }
    if (verdictCol < 0 || verdictCol >= cs.length) {
      // A table with no verdict column (the ladder, the owner breakdown) is
      // not a failure to parse — it simply is not what this reads.
      continue;
    }
    const verdict = cs[verdictCol];
    if (!VERDICT_RE.test(verdict)) {
      skipped++;
      continue;
    }
    // Column names vary between analysis sections; find each by heading rather
    // than by position, and leave a cell blank when the table does not have it.
    const at = (...names: string[]): string => {
      for (const n of names) {
        const i = header?.findIndex(h => h.includes(n)) ?? -1;
        if (i >= 0 && i < cs.length) return cs[i];
      }
      return '';
    };
    rows.push({
      metric: cs[0].replace(/^`|`$/g, ''),
      delta: at('δ count', 'count', 'delta'),
      rate: at('δ/cycle', '/cycle', 'rate'),
      size: at('δ size', 'size'),
      verdict,
    });
  }
  return {rows, skipped};
}

/**
 * The first markdown table of a tool's output, cut to `maxRows` body rows.
 * The battery writes one `<tool>.txt` per tool; the digest quotes the table
 * that carries each tool's answer instead of the prose around it.
 */
export function firstTable(text: string, maxRows: number): string[] | null {
  const out: string[] = [];
  let body = 0;
  let total = 0;
  for (const line of text.split('\n')) {
    const isRow = line.trimStart().startsWith('|');
    if (!isRow) {
      if (total > 0 && /^\s*\|[\s:|-]+\|?\s*$/.test(out[1])) break;
      // Pipes in prose (or a table with no rows) before the table: keep
      // looking.
      out.length = 0;
      body = 0;
      total = 0;
      continue;
    }
    const isSep = /^\s*\|[\s:|-]+\|?\s*$/.test(line);
    if (out.length >= 2 && !isSep) {
      total++;
      if (body >= maxRows) continue;
      body++;
    }
    out.push(line);
  }
  // A header, a separator and a data row; pipes in prose are not a table.
  if (total === 0 || !/^\s*\|[\s:|-]+\|?\s*$/.test(out[1] ?? '')) return null;
  if (total > body)
    out.push(`_…${formatNumber(total - body)} more row(s) in the full file._`);
  return out;
}

/** Where a round's battery wrote its per-tool files. */
function analysisDirs(dir: string): string[] {
  const out: string[] = [];
  for (const name of ['analysis', 'analysis-x', '.']) {
    const d = path.join(dir, name);
    try {
      if (fs.statSync(d).isDirectory()) out.push(d);
    } catch {
      // absent
    }
  }
  return out;
}

function readToolOutput(dir: string, tool: string): string | null {
  for (const d of analysisDirs(dir)) {
    const f = path.join(d, `${tool}.txt`);
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  }
  return null;
}

/** The per-tool sections a digest quotes, in reading order. */
const DIGEST_SECTIONS: Array<{tool: string; title: string; rows: number}> = [
  {tool: 'memlab_census', title: 'Census', rows: 15},
  {
    tool: 'memlab_react_update_queues',
    title: 'React update queues (top 5)',
    rows: 5,
  },
  {
    tool: 'memlab_collection_diff',
    title: 'Collections that grew (top 10, by bytes)',
    rows: 10,
  },
  {
    tool: 'memlab_dev_subtracted_delta',
    title: 'Growth with dev artifacts subtracted (top 10)',
    rows: 10,
  },
  {tool: 'memlab_positive_controls', title: 'Positive controls', rows: 10},
  {tool: 'memlab_settle_check', title: 'Settle verdicts (top 10)', rows: 10},
];

/** Leak-candidate classes in a round's `memlab_leak_report.txt`. */
export function leakCandidates(dir: string): string[] {
  const text = readToolOutput(dir, 'memlab_leak_report');
  if (text == null) return [];
  const out: string[] = [];
  let header: string[] | null = null;
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('|')) {
      if (header != null && out.length > 0) break;
      header = null;
      continue;
    }
    if (/^\s*\|[\s:|-]+\|?\s*$/.test(line)) continue;
    const cs = cells(line);
    if (header == null) {
      header = cs.map(c => c.toLowerCase());
      continue;
    }
    // Every column by its header, so a report with an extra or reordered
    // column still yields the same class+type key across rounds.
    const v = header.findIndex(h => h.includes('verdict'));
    // The exact header first; else one that ENDS in the word ("object
    // class"), so a "type count" column is never taken for the type.
    const cols = header;
    const column = (word: string) => {
      const exact = cols.indexOf(word);
      return exact >= 0
        ? exact
        : cols.findIndex(h => h.split(/\s+/).at(-1) === word);
    };
    const ci = column('class');
    const ti = column('type');
    // No guessing by position: a key from the wrong columns differs every
    // round and defeats the cross-round dedup.
    const cls = ci >= 0 ? cs[ci] : null;
    const type = ti >= 0 ? cs[ti] : null;
    if (
      cls != null &&
      type != null &&
      v >= 0 &&
      /LEAK candidate/i.test(cs[v] ?? '')
    ) {
      out.push(`${cls} (${type})`);
    }
  }
  return out;
}

export function registerRoundDigest(server: McpServer): void {
  server.tool(
    'memlab_round_digest',
    "The verdict table for a finished leak-hunt round, and nothing else. `memlab_analyze_run` writes ~30 KB of prose per round, which in practice gets grepped for verdicts rather than read — across a five-round sweep that is the single largest avoidable token cost in the analysis phase. This reads the run manifest plus any `*_analysis.txt` next to it and returns: the audit verdict and its blocking checks, the ladder shape (including whether a page reload split it), the per-metric rate/fit/verdict rows, and the round's own caveats. The full analysis stays on disk and is named in the output, so nothing is lost — it is just not paid for by default.",
    {
      run_dir: z
        .string()
        .describe(
          'Path to a leak-hunt run directory, or directly to its run.json.',
        ),
      include_analysis: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Parse `*_analysis.txt` files next to the manifest for their verdict rows (default true). Set false for the manifest audit alone.',
        ),
      max_metrics: z
        .number()
        .optional()
        .default(25)
        .describe('Maximum metric rows to show (default 25).'),
    },
    async ({run_dir, include_analysis, max_metrics}) => {
      try {
        const manifestPath = resolveManifestPath(run_dir);
        if (manifestPath == null) {
          return errorResult(
            `No run.json at ${run_dir} (nor at ${path.join(run_dir, 'run.json')}).`,
          );
        }
        const manifest = JSON.parse(
          fs.readFileSync(manifestPath, 'utf8'),
        ) as RunManifest;
        const dir = path.dirname(manifestPath);

        const audit = auditManifest(manifest);
        const rungs = manifest.rungs ?? [];
        const splits = manifest.ladder_splits_after_rung ?? [];

        const lines: string[] = [
          `# Round digest — ${manifest.run_id ?? path.basename(dir)}`,
          '',
          `**Audit verdict: ${audit.verdict}**`,
          '',
        ];

        // Only the checks that change what a reader may claim. An "ok" check is
        // the absence of a problem and does not need a row.
        const notable = audit.checks.filter(c => c.status !== 'ok');
        if (notable.length > 0) {
          lines.push(
            markdownTable(
              ['Check', 'Status', 'Detail'],
              notable.map(c => [c.name, c.status.toUpperCase(), c.detail]),
            ),
            '',
          );
        } else {
          lines.push('_All audit checks passed._', '');
        }

        const totals = manifest.totals ?? {};
        lines.push(
          `Cycles ${formatNumber(totals.cycles ?? 0)} (ok ${formatNumber(totals.ok ?? 0)} / fail ${formatNumber(totals.fail ?? 0)}) · ` +
            `${rungs.length} rung(s)` +
            (splits.length > 0
              ? ` · ⚠ ladder split after rung ${splits.join(', ')} — deltas spanning a split compare two V8 isolates`
              : '') +
            (manifest.stop_reason ? ` · stop: ${manifest.stop_reason}` : ''),
          '',
        );

        if (rungs.length > 0) {
          const first = rungs[0];
          const last = rungs[rungs.length - 1];
          const delta =
            (last.post_gc_heap_mb ?? 0) - (first.post_gc_heap_mb ?? 0);
          lines.push(
            `Post-GC heap ${(first.post_gc_heap_mb ?? 0).toFixed(1)} → ${(last.post_gc_heap_mb ?? 0).toFixed(1)} MB (${delta >= 0 ? '+' : ''}${delta.toFixed(1)} MB). ` +
              'Aggregate heap is the weakest signal in a round; the per-metric rows below decide.',
            '',
          );
        }

        if (include_analysis) {
          const analysisFiles = fs
            .readdirSync(dir)
            .filter(f => f.endsWith('_analysis.txt') || f === 'analysis.txt')
            .sort();
          if (analysisFiles.length === 0) {
            lines.push(
              '_No `*_analysis.txt` beside the manifest — run `memlab_analyze_run` first for the per-metric verdicts._',
              '',
            );
          }
          for (const file of analysisFiles) {
            const {rows, skipped} = parseAnalysis(
              fs.readFileSync(path.join(dir, file), 'utf8'),
            );
            lines.push(`## ${file}`, '');
            if (rows.length === 0) {
              lines.push(
                `_No verdict rows recognised (${formatNumber(skipped)} table line(s) skipped). Read the file directly: ${path.join(dir, file)}_`,
                '',
              );
              continue;
            }
            lines.push(
              markdownTable(
                ['Metric', 'Δ count', 'Δ/cycle', 'Δ size', 'Verdict'],
                rows
                  .slice(0, max_metrics)
                  .map(r => [r.metric, r.delta, r.rate, r.size, r.verdict]),
                new Set([1, 2, 3]),
              ),
              '',
            );
            if (rows.length > max_metrics) {
              lines.push(
                `_${formatNumber(rows.length - max_metrics)} further row(s) not shown; raise \`max_metrics\`._`,
                '',
              );
            }
            // Never silent about what was not parsed: a digest that quietly
            // dropped the one row carrying the finding would be worse than no
            // digest at all.
            if (skipped > 0) {
              lines.push(
                `_${formatNumber(skipped)} table line(s) in this file were not recognised as verdict rows and are not represented above._`,
                '',
              );
            }
          }
        }

        if (include_analysis) {
          const missing: string[] = [];
          for (const sec of DIGEST_SECTIONS) {
            const text = readToolOutput(dir, sec.tool);
            const table = text != null ? firstTable(text, sec.rows) : null;
            if (table == null) {
              missing.push(sec.tool);
              continue;
            }
            lines.push(`## ${sec.title}`, '', ...table, '');
          }
          if (missing.length > 0) {
            lines.push(
              `_Not in this round's battery output: ${missing.map(t => `\`${t}\``).join(', ')}._`,
              '',
            );
          }
        }
        lines.push(...rungMetricsSection(dir));

        if ((manifest.caveats ?? []).length > 0) {
          lines.push(
            '## Round caveats (carry these into the write-up)',
            '',
            ...(manifest.caveats ?? []).map(c => `- ${c}`),
            '',
          );
        }

        lines.push(
          `_Full analysis and manifest: ${dir}_`,
          '_This is a summary of files on disk, not a re-analysis. Run `memlab_analyze_run` to produce or refresh them._',
        );

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

/** PASS / FAIL / MIXED (p/f) / n/a from the controls table's rows, not its prose. */
function controlsVerdict(text: string | null): string {
  if (text == null) return '—';
  let pass = 0;
  let fail = 0;
  let na = 0;
  // Data rows only, anchored on the separator: rows above a `|---|` line are
  // the header (which may name both words).
  const blocks: string[][] = [];
  let cur: string[] | null = null;
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('|')) {
      if (cur == null) {
        cur = [];
        blocks.push(cur);
      }
      cur.push(line);
    } else {
      cur = null;
    }
  }
  const SEP = /^\s*\|[\s:|-]+\|?\s*$/;
  // The first table with a verdict column only: a later summary table would
  // count its rows twice.
  for (const block of blocks) {
    // Markdown tables always carry a separator; a block of pipe lines
    // without one is prose, not a table, and contributes nothing.
    const sep = block.findIndex(l => SEP.test(l));
    if (sep < 0) continue;
    // Only the Verdict/Result column is read: PASS or FAIL in a description
    // cell is prose, not a verdict. A table without one has no verdict to
    // report (`memlab_positive_controls` always prints one).
    const header =
      sep > 0 ? cells(block[sep - 1]).map(c => c.toLowerCase()) : [];
    const vi = header.findIndex(
      h => h.includes('verdict') || h.includes('result'),
    );
    // A legend or summary table without one comes first sometimes; the
    // controls table is the first that has one.
    if (vi < 0) continue;
    for (const line of block.slice(sep + 1)) {
      const cell = cells(line)[vi] ?? '';
      // FAILED / PASSED count as the verdicts they are.
      if (/\bFAIL(?:ED|S)?\b/.test(cell)) fail++;
      else if (/\bPASS(?:ED|ES)?\b/.test(cell)) pass++;
      else if (/^n\/a\b/i.test(cell.trim())) na++;
    }
    break;
  }
  if (pass === 0 && fail === 0) return na > 0 ? 'n/a' : '?';
  if (fail === 0) return 'PASS';
  return pass === 0 ? 'FAIL' : `MIXED (${pass}/${fail})`;
}

export function registerSweepDigest(server: McpServer): void {
  server.tool(
    'memlab_sweep_digest',
    'One row per round for a whole sweep, from the files each round left on disk (run.json plus the battery output): combo, cycles, rungs, audit verdict, heap, settle, positive controls, leak-candidate count — and, per round, the leak-candidate classes that NO EARLIER round in the list reported. That last column is what tells a sweep where it found something new. Pass the run directories oldest first, or one parent directory to scan for rounds.',
    {
      run_dirs: z
        .array(z.string())
        .min(1)
        .describe(
          'Round directories in sweep order, or a single parent directory whose sub-directories holding a run.json are taken in name order.',
        ),
    },
    async ({run_dirs}) => {
      try {
        let dirs = run_dirs;
        // A single path is a parent to scan only if it is not itself a round
        // (resolved the same way each round is below).
        if (dirs.length === 1 && resolveManifestPath(dirs[0]) == null) {
          // An unreadable parent is an error, not an empty sweep.
          dirs = fs
            .readdirSync(dirs[0])
            .map(d => path.join(dirs[0], d))
            .filter(d => fs.existsSync(path.join(d, 'run.json')))
            .sort((a, b) =>
              path
                .basename(a)
                .localeCompare(path.basename(b), 'en', {numeric: true}),
            );
        }
        if (dirs.length === 0) {
          return errorResult('No round directory with a run.json found.');
        }
        const seen = new Set<string>();
        const rows: string[][] = [];
        for (const dir of dirs) {
          const mp = resolveManifestPath(dir);
          if (mp == null) {
            rows.push([
              path.basename(dir),
              '—',
              '—',
              '—',
              'no run.json',
              '—',
              '—',
              '—',
              '—',
              '—',
            ]);
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(fs.readFileSync(mp, 'utf8'));
          } catch {
            rows.push([
              path.basename(dir),
              '—',
              '—',
              '—',
              'unreadable run.json',
              '—',
              '—',
              '—',
              '—',
              '—',
            ]);
            continue;
          }
          const m = parsed as RunManifest & {
            settle_rung?: unknown;
            settle_void?: {reason?: string} | null;
            environment?: {dev_build?: boolean | null};
          };
          const rungs = m.rungs ?? [];
          const first = rungs[0]?.post_gc_heap_mb;
          const last = rungs[rungs.length - 1]?.post_gc_heap_mb;
          // One round's unreadable battery file costs that round's columns,
          // not the whole sweep table.
          let control = '?';
          let candidates: string[] = [];
          let candidatesNote = '';
          try {
            control = controlsVerdict(
              readToolOutput(path.dirname(mp), 'memlab_positive_controls'),
            );
          } catch {
            control = 'unreadable';
          }
          try {
            candidates = leakCandidates(path.dirname(mp));
          } catch {
            candidatesNote = 'leak report unreadable';
          }
          const fresh = candidates.filter(c => !seen.has(c));
          for (const c of candidates) seen.add(c);
          rows.push([
            path.basename(path.dirname(mp)),
            (Array.isArray(m.config?.combos) ? m.config.combos : []).join(
              ', ',
            ) + (m.environment?.dev_build === false ? ' (prod-like)' : ''),
            formatNumber(m.totals?.cycles ?? 0),
            String(rungs.length),
            auditManifest(m).verdict,
            first != null && last != null
              ? `${first.toFixed(0)} → ${last.toFixed(0)} MB`
              : '—',
            m.settle_void != null
              ? 'VOID'
              : m.settle_rung != null
                ? 'yes'
                : 'no',
            control,
            candidatesNote !== '' ? '?' : String(candidates.length),
            candidatesNote !== ''
              ? candidatesNote
              : fresh.length === 0
                ? '—'
                : fresh.slice(0, 4).join('; ') +
                  (fresh.length > 4 ? ` +${fresh.length - 4}` : ''),
          ]);
        }
        return toolResult(
          [
            `# Sweep digest — ${dirs.length} round(s)`,
            '',
            markdownTable(
              [
                'Round',
                'Combo',
                'Cycles',
                'Rungs',
                'Audit',
                'Post-GC heap',
                'Settle',
                'Controls',
                'Candidates',
                'New vs earlier rounds',
              ],
              rows,
            ),
            '',
            '_Candidates are `memlab_leak_report` rows whose verdict is a LEAK candidate, matched by class and type. A round that reports nothing new on a surface no earlier round drove is the signal to move to a different surface._',
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
