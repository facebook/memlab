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
 * Rows of `<metric>: <rate> (r2)` lifted out of an analysis text file.
 *
 * The analysis files are markdown written for a human; this reads only the
 * lines that carry a verdict. Tolerant by design — a line it cannot parse is
 * skipped rather than guessed at, and the count of skipped lines is reported so
 * "the digest found nothing" is never mistaken for "the round found nothing".
 */
interface MetricRow {
  metric: string;
  rate: string;
  fit: string;
  verdict: string;
}

const RATE_LINE =
  /^\s*\|\s*`?([A-Za-z0-9_.$<> -]+?)`?\s*\|\s*([+\-0-9.,]+(?:\s*\/\s*cycle)?)\s*\|\s*(r²?\s*=?\s*[0-9.]+|—|-)\s*\|\s*([A-Z_ ]+)\s*\|/;

function parseAnalysis(text: string): {rows: MetricRow[]; skipped: number} {
  const rows: MetricRow[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    if (/^\s*\|\s*[-: ]+\|/.test(line)) continue; // separator
    const m = RATE_LINE.exec(line);
    if (m) {
      rows.push({
        metric: m[1].trim(),
        rate: m[2].trim(),
        fit: m[3].trim(),
        verdict: m[4].trim(),
      });
    } else {
      skipped++;
    }
  }
  return {rows, skipped};
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
                ['Metric', 'Rate', 'Fit', 'Verdict'],
                rows
                  .slice(0, max_metrics)
                  .map(r => [r.metric, r.rate, r.fit, r.verdict]),
                new Set([1, 2]),
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
