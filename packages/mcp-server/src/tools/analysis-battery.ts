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
 * Run a round's whole analysis in one call, write the detail to disk, and
 * return only a digest.
 *
 * `memlab_batch` already runs several tools in one session, which is the half
 * that saves wall clock — the snapshot load dominates, so N tools over one
 * resident graph costs about what one does. But it returns every result INLINE,
 * and that is the half that makes a sweep impossible: a standard round's worth
 * of tools is tens of thousands of tokens of prose, and twenty rounds of it does
 * not fit in any context window.
 *
 * A session that ran a twenty-round sweep hand-rolled this — a JSONL of ~35 tool
 * calls piped through the CLI, stdout split on the per-tool banner into
 * per-tool files, plus a shell script to grep fifteen headline lines back out.
 * That script was the difference between the sweep being feasible and not, and
 * it lived in /tmp and died with the host. This is that, as a tool.
 *
 * The digest is deliberately small and fixed: audit verdict, app-vs-artifact
 * split, the top growers with rate and fit, census totals, the named
 * collections over a size threshold. Everything else is a file path. The point
 * is that a round costs a bounded number of tokens to READ, and the detail is
 * still there when a specific question needs it.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import path from 'path';
import {z} from 'zod';
import {loadRunManifest} from '../run-manifest.js';
import {getRegisteredTool} from '../tool-registry.js';
import {errorResult, formatNumber, toolResult} from '../utils.js';

/** One step of a battery: a tool and the args it gets. */
interface Step {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * The tool sets, ordered so the cheap ladder-level passes (which load rungs
 * transiently, one at a time) run before the single-snapshot deep dive (which
 * holds the final rung resident).
 *
 * Taken from the battery a real sweep converged on rather than from the tool
 * list — these are the calls that actually got read.
 */
function buildPlan(
  profile: string,
  runDir: string,
  paths: string[],
  cycles: number,
  finalRung: string,
  baseRung: string,
): Step[] {
  const ladder: Step[] = [
    {tool: 'memlab_round_audit', args: {run_dir: runDir}},
    {tool: 'memlab_leak_report', args: {run_dir: runDir, limit: 14}},
    {
      tool: 'memlab_artifact_budget',
      args: {target: finalRung, baseline: baseRung},
    },
    {
      tool: 'memlab_census_diff',
      args: {baseline: baseRung, target: finalRung, top_n: 30},
    },
  ];

  const deep: Step[] = [
    {
      tool: 'memlab_load_snapshot',
      args: {file_path: finalRung, quiet: true, suppress_suggestions: true},
    },
    {tool: 'memlab_app_heap', args: {}},
    {tool: 'memlab_dev_artifacts', args: {}},
    {tool: 'memlab_cache_analysis', args: {}},
    {tool: 'memlab_stale_collections', args: {}},
    {tool: 'memlab_growth_signals', args: {}},
    {tool: 'memlab_detached_dom', args: {group_by: 'dominator'}},
    {tool: 'memlab_event_listener_leaks', args: {}},
    {tool: 'memlab_react_update_queues', args: {}},
    {tool: 'memlab_async_census', args: {}},
    {tool: 'memlab_retention_windows', args: {}},
  ];

  const optimization: Step[] = [
    {tool: 'memlab_duplicated_strings', args: {}},
    {tool: 'memlab_intern_opportunities', args: {}},
    {tool: 'memlab_duplicate_objects', args: {}},
    {tool: 'memlab_shape_histogram', args: {}},
    {tool: 'memlab_sparse_elements', args: {}},
    {tool: 'memlab_script_census', args: {}},
    {tool: 'memlab_largest_objects', args: {}},
  ];

  const extra: Step[] = [
    {tool: 'memlab_sequence_analysis', args: {run_dir: runDir}},
    {tool: 'memlab_auto_investigate', args: {}},
    {tool: 'memlab_quick_diagnosis', args: {}},
    {tool: 'memlab_pinch_points', args: {}},
    {tool: 'memlab_event_registry', args: {}},
    {tool: 'memlab_weakref_census', args: {}},
    {tool: 'memlab_global_variables', args: {}},
    {tool: 'memlab_react_owners', args: {}},
    {tool: 'memlab_dom_audit', args: {}},
    {tool: 'memlab_id_space_audit', args: {}},
    {tool: 'memlab_class_histogram', args: {limit: 40}},
    {tool: 'memlab_next_measurement', args: {}},
  ];

  if (profile === 'optimization') return [...ladder, ...deep, ...optimization];
  if (profile === 'deep') {
    return [...ladder, ...deep, ...optimization, ...extra];
  }
  return [...ladder, ...deep];
}

/** Lines worth lifting into the digest, per tool. */
const DIGEST_PATTERNS: ReadonlyArray<{tool: RegExp; re: RegExp; max: number}> =
  [
    {tool: /round_audit/, re: /^\*\*Verdict:.*$|^\| [⚠✅❌]/, max: 10},
    {
      tool: /artifact_budget/,
      re: /not the application|^\*\*app_delta|^\| (App|TOTAL) /,
      max: 5,
    },
    {tool: /leak_report/, re: /^\| [A-Za-z(]/, max: 9},
    {tool: /census_diff/, re: /^Totals:/, max: 4},
    {tool: /cache_analysis/, re: /^\| @|dev-only/, max: 8},
    {tool: /stale_collections/, re: /^\| @/, max: 5},
    {tool: /growth_signals/, re: /^\| @/, max: 5},
    {tool: /react_update_queues/, re: /^\*\*Breadth|^\| [A-Za-z]/, max: 7},
    {tool: /async_census/, re: /scheduler task record|UNSETTLED/, max: 3},
    {tool: /detached_dom/, re: /^Totals:|^\*\*/, max: 3},
    {tool: /retention_windows/, re: /window-shaped key|longer than it/, max: 3},
    {tool: /intern_opportunities/, re: /^Verdict:/, max: 2},
    {tool: /duplicate_objects/, re: /collapse to|Reclaimable/, max: 2},
    {tool: /app_heap/, re: /application|bundle/, max: 4},
  ];

function digestFor(tool: string, text: string): string[] {
  const spec = DIGEST_PATTERNS.find(p => p.tool.test(tool));
  if (!spec) return [];
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (spec.re.test(line)) {
      out.push(line.trim());
      if (out.length >= spec.max) break;
    }
  }
  return out;
}

function textOf(result: unknown): string {
  const content = (result as {content?: Array<{text?: string}>})?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map(c => (typeof c?.text === 'string' ? c.text : ''))
    .join('\n');
}

export function registerAnalysisBattery(server: McpServer): void {
  server.tool(
    'memlab_analysis_battery',
    "Run a round's whole analysis in ONE call, write every tool's output to disk, and return only a digest.\n\n" +
      "The snapshot load dominates the cost of every tool, so running the standard set over one resident graph costs roughly what running three of them separately does. The reason this is a separate tool from `memlab_batch` is the OUTPUT: a batch returns every result inline, and a round's worth of tool prose is tens of thousands of tokens — which is why a twenty-round sweep is impossible to read without this. Detail goes to `<out_dir>/<tool>.txt`; the digest that comes back is the audit verdict, the app-vs-artifact split, the top growers with rate and fit, census totals and the named collections.\n\n" +
      'Give it `run_dir` and it resolves the ladder, the per-rung cycle counts and the total cycles from `run.json`, so the per-cycle axis is measured rather than assumed.\n\n' +
      'Profiles: `standard` (ladder + leak detectors), `optimization` (adds string/shape/duplication analysis), `deep` (everything, including the slower single-snapshot passes).',
    {
      run_dir: z
        .string()
        .describe(
          "The leak-hunt round's output directory — the one holding run.json and snapshots/.",
        ),
      out_dir: z
        .string()
        .optional()
        .describe(
          'Where to write the per-tool output files. Defaults to `<run_dir>/analysis`.',
        ),
      profile: z
        .enum(['standard', 'optimization', 'deep'])
        .optional()
        .default('standard')
        .describe(
          'Which tool set to run. `standard` is the leak-hunt set; `optimization` adds duplication/interning/shape analysis; `deep` runs everything and is materially slower.',
        ),
      timeout_ms: z
        .number()
        .optional()
        .describe(
          'Budget for the whole battery. Checked BETWEEN steps — a whole-heap pass is one synchronous block and cannot be interrupted — so the guarantee is that no NEW step starts past the deadline.',
        ),
    },
    async ({run_dir, out_dir, profile, timeout_ms}) => {
      try {
        const manifest = loadRunManifest(run_dir);
        if (manifest.paths.length < 2) {
          return errorResult(
            new Error(
              `run.json lists ${manifest.paths.length} rung(s); a battery needs at least 2.`,
            ),
          );
        }
        const missing = manifest.paths.filter(p => !fs.existsSync(p));
        if (missing.length > 0) {
          return errorResult(
            new Error(
              `${missing.length} rung file(s) named in run.json are missing:\n` +
                missing.map(m => `- ${m}`).join('\n'),
            ),
          );
        }

        const outDir =
          out_dir ?? path.join(run_dir.replace(/\/$/, ''), 'analysis');
        fs.mkdirSync(outDir, {recursive: true});

        const finalRung = manifest.paths[manifest.paths.length - 1];
        const baseRung = manifest.paths[0];
        const plan = buildPlan(
          profile,
          run_dir,
          manifest.paths,
          manifest.cycles,
          finalRung,
          baseRung,
        );

        const deadline =
          timeout_ms != null && timeout_ms > 0 ? Date.now() + timeout_ms : null;

        const digestLines: string[] = [];
        const written: Array<{tool: string; bytes: number; ms: number}> = [];
        const failures: string[] = [];
        let skipped = 0;

        for (const step of plan) {
          if (deadline != null && Date.now() > deadline) {
            skipped++;
            continue;
          }
          const entry = getRegisteredTool(step.tool);
          if (entry == null) {
            // A profile naming a tool this build does not have is a bug in the
            // profile, not a reason to abandon the round.
            failures.push(`${step.tool}: not registered in this build`);
            continue;
          }
          const started = Date.now();
          let text: string;
          try {
            const parsed =
              entry.shape != null
                ? z.object(entry.shape as never).parse(step.args)
                : step.args;
            text = textOf(await entry.handler(parsed, {}));
          } catch (err: unknown) {
            text = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
            failures.push(`${step.tool}: ${text.slice(0, 160)}`);
          }
          const ms = Date.now() - started;
          const file = path.join(outDir, `${step.tool}.txt`);
          fs.writeFileSync(file, text, 'utf8');
          written.push({tool: step.tool, bytes: text.length, ms});

          const d = digestFor(step.tool, text);
          if (d.length > 0) {
            digestLines.push(`### ${step.tool}`, ...d, '');
          }
        }

        const lines: string[] = [
          `## Analysis battery — \`${path.basename(run_dir.replace(/\/$/, ''))}\` (${profile})`,
          '',
          `${manifest.paths.length} rungs at cycles [${manifest.cyclesPerRung.join(', ')}], ` +
            `${formatNumber(manifest.cycles)} cycles driven` +
            (manifest.combos.length > 0
              ? `, combos: ${manifest.combos.join(', ')}`
              : '') +
            '.',
          '',
          `**${written.length} tool(s) run**, output written to \`${outDir}/\`` +
            (skipped > 0 ? `; ${skipped} skipped for budget` : '') +
            (failures.length > 0 ? `; ${failures.length} failed` : '') +
            '.',
          '',
        ];

        if (manifest.caveats.length > 0) {
          lines.push('**Caveats recorded by the runner:**');
          for (const c of manifest.caveats) lines.push(`- ${c}`);
          lines.push('');
        }
        if (manifest.splitAfterRung.length > 0) {
          lines.push(
            `> ⚠️ **LADDER SPLIT after rung ${manifest.splitAfterRung.join(', ')}** — rungs across that ` +
              'boundary are different V8 isolates and must not be compared. Analyze each segment on its own.',
            '',
          );
        }

        lines.push('## Digest', '');
        lines.push(
          digestLines.length > 0
            ? digestLines.join('\n')
            : '_No digest lines matched; read the files below._',
        );
        lines.push('');

        if (failures.length > 0) {
          lines.push('## Failed steps', '');
          for (const f of failures) lines.push(`- ${f}`);
          lines.push('');
        }

        lines.push('## Files', '');
        for (const w of written.sort((a, b) => b.bytes - a.bytes)) {
          lines.push(
            `- \`${w.tool}.txt\` — ${formatNumber(w.bytes)} B, ${formatNumber(w.ms)} ms`,
          );
        }
        lines.push('');
        lines.push(
          `_Full output for any tool is at \`${outDir}/<tool>.txt\`. The digest above is fixed and ` +
            'small on purpose: a round should cost a bounded number of tokens to read, with the ' +
            'detail still on disk when a specific question needs it._',
        );

        return toolResult(lines.join('\n'));
      } catch (e: unknown) {
        return errorResult(e);
      }
    },
  );
}
