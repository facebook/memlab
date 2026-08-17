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
import path from 'path';
import memlabHeapAnalysis from '@memlab/heap-analysis';
import {z} from 'zod';
import {getRegisteredTool} from '../tool-registry.js';
import {
  activeElapsedMs,
  activeTimeoutMs_,
  beginAnalysisBudget,
  endAnalysisBudget,
  ScanTimeoutError,
} from '../analysis-budget.js';
import {
  clearAllSnapshots,
  listSnapshots,
  setCurrentSnapshot,
  setSnapshot,
} from '../heap-state.js';
import {artifactLabel, type ArtifactKind} from '../artifact-classes.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';
import {computeSequenceTrends} from './sequence-analysis.js';

const {getFullHeapFromFile} = memlabHeapAnalysis;

interface RunRung {
  index: number;
  path: string;
  cycles: number;
  post_gc_heap_mb: number;
  reason?: string;
}

interface RunManifest {
  run_id?: string;
  config?: {combos?: string[]; target_cycles?: number; url_filter?: string};
  totals?: {cycles?: number; ok?: number; fail?: number};
  rungs?: RunRung[];
  gating_verified?: Record<string, unknown>;
  caveats?: string[];
  stop_reason?: string | null;
  ab?: Record<string, unknown>;
}

/**
 * Run one already-registered tool in-process against the current snapshot.
 *
 * Same dispatch `memlab_batch` uses, and for the same reason: the analysis is a
 * fixed sequence of existing tools, and re-implementing any of them here would
 * let the protocol's answer drift from the answer the operator gets by hand.
 * Failures are captured as text rather than thrown — one missing section must
 * not cost the whole write-up.
 *
 * Each step gets its OWN wall clock, armed through the server's COOPERATIVE
 * budget rather than a timer. That distinction is the whole design: a heap walk
 * is synchronous, so it blocks the event loop and a `setTimeout` racing it can
 * never fire — a timer-based budget bounds nothing and only looks like it does.
 * Measured while building this: with a 90s timer-based step budget, the deep
 * dive on a 3-rung / 700 MB ladder was still running at 14 minutes with no
 * output. `beginAnalysisBudget` instead makes `tickAnalysis()`, which the
 * snapshot's patched `forEach` already calls, throw from INSIDE the walk.
 *
 * A step that overruns is reported as UNANALYZED — the same contract the rest
 * of this tool holds itself to — and the protocol moves on.
 *
 * The outer budget is restored afterwards so the remaining steps still run
 * under the caller's overall `timeout_ms`.
 */
async function runTool(
  name: string,
  args: Record<string, unknown>,
  budgetMs: number,
  unanalyzed: string[],
): Promise<string> {
  const entry = getRegisteredTool(name);
  if (entry == null) return `_(${name} is not registered on this server)_`;
  const outerRemaining = Math.max(0, activeTimeoutMs_() - activeElapsedMs());
  const outerTimeout = activeTimeoutMs_();
  beginAnalysisBudget(budgetMs);
  try {
    const res = await entry.handler(args, {});
    const content = (res as {content?: Array<{text?: string}>})?.content;
    const text = Array.isArray(content)
      ? content.map(c => c.text ?? '').join('\n')
      : String(res);
    // A tool that fails does NOT throw: every handler catches its own errors
    // and returns an `isError` envelope, budget overruns included. Treating
    // only exceptions as failures is how this write-up printed "every step of
    // the protocol ran" underneath a step that had aborted mid-walk — the exact
    // false clean-bill this tool exists to prevent. (`memlab_batch` learned the
    // same lesson; see `isErrorResult` there.)
    if ((res as {isError?: unknown})?.isError === true) {
      const overran = /budget|timed? ?out|exceeded/i.test(text);
      unanalyzed.push(
        overran
          ? `${name} exceeded its ${Math.round(budgetMs / 1000)}s step budget`
          : `${name} failed`,
      );
      return overran
        ? `_(${name} exceeded its ${Math.round(budgetMs / 1000)}s step budget and was aborted mid-walk — raise \`step_timeout_s\`, or run it directly against the resident snapshots.)_\n\n${text}`
        : text;
    }
    return text.trim() || '_(no output)_';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut =
      err instanceof ScanTimeoutError || /timed? ?out|budget/i.test(msg);
    unanalyzed.push(
      timedOut
        ? `${name} exceeded its ${Math.round(budgetMs / 1000)}s step budget`
        : `${name} failed`,
    );
    return timedOut
      ? `_(${name} exceeded its ${Math.round(budgetMs / 1000)}s step budget and was aborted mid-walk. Run it directly against the resident snapshots with a larger \`timeout_ms\`, or raise \`step_timeout_s\`.)_`
      : `_(${name} failed: ${msg})_`;
  } finally {
    // Restore the caller's budget, minus what this step consumed, so the
    // remaining steps still run under the overall timeout rather than getting
    // a fresh one each.
    if (outerTimeout > 0) {
      beginAnalysisBudget(Math.max(1, outerRemaining));
    } else {
      endAnalysisBudget();
    }
  }
}

/** Load a snapshot file and register it under `alias`, keeping the others. */
async function loadRung(filePath: string, alias: string): Promise<void> {
  const snapshot = await getFullHeapFromFile(filePath);
  let nodeCount = 0;
  let totalSize = 0;
  snapshot.nodes.forEach(n => {
    nodeCount++;
    totalSize += n.self_size;
  });
  let edgeCount = 0;
  snapshot.edges.forEach(() => {
    edgeCount++;
  });
  setSnapshot(
    snapshot,
    filePath,
    {
      fileName: path.basename(filePath),
      nodeCount,
      edgeCount,
      totalSize,
      env: 'browser',
    },
    {alias, replace: false},
  );
}

/**
 * One-line, non-empty label for a class in a table or a sentence.
 *
 * V8 leaves anonymous arrays and closures unnamed, and value-named string
 * "classes" carry their whole (often multi-line) value — both of which render as
 * a blank cell or a broken paragraph if passed through unchanged.
 */
function classLabel(name: string, type: string, maxLen = 38): string {
  const flat = name.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return `(unnamed ${type})`;
  return flat.length > maxLen ? `${flat.slice(0, maxLen - 1)}…` : flat;
}

export function registerAnalyzeRun(server: McpServer): void {
  server.tool(
    'memlab_analyze_run',
    "Point at a leak hunt's `run.json` and get the whole analysis protocol executed in one call: ladder trend, owner attribution for the growth, a detached-DOM population comparison between the first and last rung, dev/automation-artifact classification, and a per-grower adjudication — plus the run's own caveats (gating, relink seams, stall) carried into the write-up. " +
      '`memlab_hunt_report` renders the run and `memlab_leak_report` analyses the ladder; nothing chained them, so how thorough a round got depended on how thorough the operator felt like being, which is the single largest source of variance between rounds. This runs the same sequence every time and states explicitly which steps did not run. ' +
      'Cost: it loads the ladder transiently for the trend, then holds the FIRST and LAST rung resident together for the attribution and population steps — size `timeout_ms` accordingly (600000+ for a multi-hundred-MB ladder), and expect several minutes. ' +
      'KNOWN LIMITATION, measured on two apps: the `dev_artifacts` step reliably exceeds a 200-240s step budget here (aborting at ~10.8M nodes scanned) while the same tool returns in 2-5s when called directly on the same snapshot. Unloading the baseline first does NOT change it, so residency is not the cause and the cause is not yet identified. The step is reported as UNANALYZED rather than waited out; run `memlab_dev_artifacts` yourself against the final rung, or raise `step_timeout_s`, to complete that part of the protocol.',
    {
      run_json: z
        .string()
        .describe(
          'Path to a run.json written by hunt_runner (or to the run directory containing it).',
        ),
      cycles_between_rungs: z
        .number()
        .optional()
        .describe(
          'Override the interaction cycles between consecutive rungs. Defaults to the per-rung `cycles` recorded in the manifest.',
        ),
      top: z
        .number()
        .optional()
        .default(12)
        .describe('How many growing classes to adjudicate (default 12).'),
      skip_deep_dive: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Run only the ladder trend, skipping the two-snapshot-resident steps (owner attribution, population diff, artifacts). Use on a ladder too large to hold two rungs in memory at once.',
        ),
      step_timeout_s: z
        .number()
        .optional()
        .default(240)
        .describe(
          'Wall clock for EACH deep-dive step (default 240s). A step that overruns is reported as UNANALYZED instead of being waited out — several whole-heap steps chained behind one budget is how a protocol turns into a hung session. Raise it for very large ladders.',
        ),
      max_file_size_mb: z
        .number()
        .optional()
        .describe('Per-file size limit override (MB).'),
    },
    async ({
      run_json,
      cycles_between_rungs,
      top,
      skip_deep_dive,
      step_timeout_s,
      max_file_size_mb,
    }) => {
      try {
        let manifestPath = run_json;
        if (
          fs.existsSync(manifestPath) &&
          fs.statSync(manifestPath).isDirectory()
        ) {
          manifestPath = path.join(manifestPath, 'run.json');
        }
        if (!fs.existsSync(manifestPath)) {
          return errorResult(`No run.json at ${manifestPath}.`);
        }
        const manifest = JSON.parse(
          fs.readFileSync(manifestPath, 'utf8'),
        ) as RunManifest;
        const rungs = (manifest.rungs ?? []).filter(r => fs.existsSync(r.path));
        const missing = (manifest.rungs ?? []).length - rungs.length;
        if (rungs.length < 2) {
          return errorResult(
            `The run has ${rungs.length} readable rung(s); the protocol needs at least 2. ` +
              (missing > 0
                ? `${missing} rung file(s) listed in the manifest are missing from disk — snapshots are usually written to /tmp and may have been cleaned up.`
                : 'Capture more rungs, or analyze the single snapshot directly with memlab_load_snapshot + memlab_auto_investigate.'),
          );
        }

        // The steps that did NOT run are part of the result. A protocol whose
        // gaps are invisible reads as a complete analysis, which is how a round
        // gets published with a step quietly missing.
        const unanalyzed: string[] = [];
        const stepBudgetMs = Math.max(1, step_timeout_s) * 1000;
        if (missing > 0) {
          unanalyzed.push(
            `${missing} rung file(s) from the manifest are missing on disk and were excluded.`,
          );
        }

        const paths = rungs.map(r => r.path);
        const first = rungs[0];
        const last = rungs[rungs.length - 1];
        const perRungCycles =
          cycles_between_rungs ??
          (rungs.length > 1
            ? Math.round((last.cycles - first.cycles) / (rungs.length - 1))
            : 0);

        const out: string[] = [
          `# Leak-hunt analysis — ${manifest.run_id ?? path.basename(path.dirname(manifestPath))}`,
          '',
          `Combos: ${(manifest.config?.combos ?? []).join(', ') || '(unrecorded)'} · cycles driven: ${formatNumber(manifest.totals?.cycles ?? last.cycles)} (ok ${formatNumber(manifest.totals?.ok ?? 0)} / fail ${formatNumber(manifest.totals?.fail ?? 0)}) · ${rungs.length} rungs · ~${formatNumber(perRungCycles)} cycles between rungs`,
          manifest.stop_reason ? `Stop reason: ${manifest.stop_reason}` : '',
          '',
          '## Ladder',
          '',
          markdownTable(
            ['Rung', 'Cycles', 'Post-GC heap', 'Reason'],
            rungs.map(r => [
              String(r.index),
              formatNumber(r.cycles),
              `${r.post_gc_heap_mb.toFixed(1)} MB`,
              r.reason ?? '',
            ]),
            new Set([0, 1, 2]),
          ),
          '',
        ].filter(Boolean);

        const heapDelta = last.post_gc_heap_mb - first.post_gc_heap_mb;
        out.push(
          `Aggregate post-GC heap moved **${heapDelta >= 0 ? '+' : ''}${heapDelta.toFixed(1)} MB** across the run. Aggregate heap is the weakest signal here and is reported for completeness only: a measured round found a real leak (+6.25 undo entries/cycle, linear across five rungs) while aggregate heap FELL 8.9 MB. The per-class trend below is what decides.`,
          '',
        );

        // ---- Step 1: ladder trend (transient loads, one graph at a time) ----
        out.push('## 1. Per-class trend across the ladder', '');
        let growers: Array<{
          name: string;
          type: string;
          netCount: number;
          netSize: number;
          trend: string;
          artifact: ArtifactKind | null;
        }> = [];
        try {
          const trends = await computeSequenceTrends(paths, {
            minGrowthCount: 1,
            maxFileSizeMB: max_file_size_mb,
            toolName: 'memlab_analyze_run',
          });
          growers = trends.rows.slice(0, top).map(r => ({
            name: r.name,
            type: r.type,
            netCount: r.netCount,
            netSize: r.netSize,
            trend: r.trend,
            artifact: r.artifact,
          }));
          if (growers.length === 0) {
            out.push(
              'No class grew across the ladder. That is a RESULT, not a failed analysis — record the round as no-leak for these combos rather than re-running until something appears.',
              '',
            );
          } else {
            out.push(
              markdownTable(
                [
                  'Class',
                  'Type',
                  'Δ count',
                  'Δ/cycle',
                  'Δ size',
                  'Adjudication',
                ],
                growers.map(g => [
                  classLabel(g.name, g.type),
                  g.type,
                  `+${formatNumber(g.netCount)}`,
                  perRungCycles > 0
                    ? (
                        g.netCount /
                        (perRungCycles * (rungs.length - 1))
                      ).toFixed(2)
                    : '—',
                  `${g.netSize >= 0 ? '+' : ''}${formatBytes(g.netSize)}`,
                  g.artifact != null
                    ? artifactLabel(g.artifact)
                    : g.trend === 'monotonic-up'
                      ? '↑ every rung — LEAK CANDIDATE'
                      : 'grew net (noisy) — weak',
                ]),
                new Set([2, 3, 4]),
              ),
              '',
            );
            const candidates = growers.filter(
              g => g.artifact == null && g.trend === 'monotonic-up',
            );
            out.push(
              candidates.length > 0
                ? `**${candidates.length} leak candidate(s)** after artifact classification: ${candidates.map(c => `\`${classLabel(c.name, c.type, 28)}\``).join(', ')}. A candidate is not a verdict — the retainer evidence below is what promotes it.`
                : '**No leak candidates** survived artifact classification: every grower is either a known measurement-artifact family or non-monotonic.',
              '',
            );
          }
        } catch (err) {
          out.push(
            `_Trend step FAILED: ${err instanceof Error ? err.message : String(err)}_`,
            '',
          );
          unanalyzed.push('per-class ladder trend');
        }

        // ---- Step 2+: two rungs resident ----
        if (skip_deep_dive) {
          unanalyzed.push(
            'owner attribution, detached-DOM population diff and artifact classification (skip_deep_dive was set)',
          );
        } else {
          // Start from a clean slate: the deep dive needs exactly two graphs
          // resident, and anything left over from an earlier call is both
          // memory pressure and a chance to attribute against the wrong pair.
          clearAllSnapshots();
          let loaded = false;
          try {
            await loadRung(first.path, 'run_first');
            await loadRung(last.path, 'run_last');
            loaded = true;
          } catch (err) {
            out.push(
              `_Could not hold both rungs resident: ${err instanceof Error ? err.message : String(err)}. Re-run with skip_deep_dive to get the trend alone._`,
              '',
            );
            unanalyzed.push(
              'owner attribution, population diff and artifact classification (both rungs would not load)',
            );
          }

          if (loaded) {
            setCurrentSnapshot('run_last');
            out.push(
              '## 2. Who owns the growth',
              '',
              await runTool(
                'memlab_explain_delta',
                {
                  baseline_handle: 'run_first',
                  target_handle: 'run_last',
                  limit: 12,
                  min_delta_bytes: 65536,
                  include_artifacts: false,
                },
                stepBudgetMs,
                unanalyzed,
              ),
              '',
              '## 3. Detached DOM — same population, or the same count?',
              '',
              await runTool(
                'memlab_population_diff',
                {
                  baseline_handle: 'run_first',
                  target_handle: 'run_last',
                  population: 'detached',
                  group_by: 'owner',
                  limit: 15,
                  min_delta: 0,
                },
                stepBudgetMs,
                unanalyzed,
              ),
              '',
              await runTool(
                'memlab_detached_dom',
                {
                  output_mode: 'full',
                  group_by: 'dominator',
                  limit: 8,
                  offset: 0,
                  classify_dev_only: true,
                  only_with_retainer_path: false,
                },
                stepBudgetMs,
                unanalyzed,
              ),
              '',
              '## 4. Is it real? (dev/automation artifacts on the final rung)',
              '',
              await runTool(
                'memlab_dev_artifacts',
                {},
                stepBudgetMs,
                unanalyzed,
              ),
              '',
            );
          }
        }

        // ---- Provenance and caveats ----
        out.push('## Round provenance and caveats', '');
        const gating = manifest.gating_verified ?? {};
        const gatingKeys = Object.keys(gating);
        out.push(
          gatingKeys.length > 0
            ? `Gating: ${gatingKeys.length} ABProp(s) verified in-page. ${gatingKeys
                .map(k => `\`${k}\`=${JSON.stringify(gating[k])}`)
                .join(', ')}`
            : '⚠ **No verified gating recorded in this run.** A round driven without its gating manifest re-discovers already-fixed leaks and cannot be compared with a gated round — treat every finding above as provisional.',
          '',
        );
        const caveats = manifest.caveats ?? [];
        if (caveats.length > 0) {
          out.push(
            '**Caveats recorded by the runner** (these constrain what the analysis above can claim):',
            ...caveats.map(c => `- ${c}`),
            '',
          );
        }
        if (unanalyzed.length > 0) {
          out.push(
            '**UNANALYZED** — these protocol steps did not run, so the round is not a clean no-leak result:',
            ...unanalyzed.map(u => `- ${u}`),
            '',
          );
        } else {
          out.push(
            '_Every step of the protocol ran. "No leak candidates" from a complete run is a genuine no-leak result; the same words from a run with UNANALYZED steps are not._',
            '',
          );
        }
        const resident = listSnapshots()
          .map(m => m.handle)
          .join(', ');
        if (resident) {
          out.push(
            `_Resident snapshots: ${resident}. Follow up on a specific object with \`memlab_dominator_chain\` / \`memlab_retainer_trace\`, or unload them with \`memlab_snapshots\`._`,
          );
        }
        return toolResult(out.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
