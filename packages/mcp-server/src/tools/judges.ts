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
 * Judge a round against its stated invariants, at rest.
 *
 * The question this answers is narrower than "what grew?": which plain-words
 * claim about the app stopped being true once driving stopped and the settle
 * rung was captured. Running the same judges on every round is what makes one
 * round's green comparable with the next one's.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {
  judgeSeries,
  measureJudges,
  resolveInvariantSpec,
  type JudgeVerdict,
} from '../judges.js';
import {loadRunManifest} from '../run-manifest.js';
import {snapshotExists} from '../snapshot-index.js';
import {
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
} from '../snapshot-borrow.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

export const INVARIANTS_ARG_DESCRIPTION =
  "Inline invariants: [{name, words?, probe, visibility_probe?, expect, max_per_cycle?, tolerance?, abs_tolerance?, max?, rule?}]. `rule` names the fix this judge guards. `expect` is one of no-growth | returns-to-baseline | bounded | zero-at-rest. `probe` is memlab_eval code assigning one number to `result`. Overrides `invariants_file` and the round's invariants.json.";

export const INVARIANTS_FILE_ARG_DESCRIPTION =
  'Path to an invariants.json ({prelude?, invariants: [...]}, or a bare array). Defaults to <run_dir>/invariants.json, then a run.json `invariants` key.';

const ORDER: JudgeVerdict[] = [
  'LEAK',
  'ERROR',
  'UNSETTLED',
  'UNVERIFIED',
  'BACKLOG',
  'PASS',
];

export function registerJudges(server: McpServer): void {
  server.tool(
    'memlab_judges',
    'Judge a leak-hunt round against its stated INVARIANTS — plain-words claims about what must hold once the app is at rest — instead of reading "what grew". Each invariant is a probe (memlab_eval code returning one number), an optional visibility probe on the same access path, and an expectation: `no-growth`, `returns-to-baseline`, `bounded` or `zero-at-rest`. Every probe runs on every driven rung and on the settle rung in ONE pass (each rung loads once). Verdicts: PASS; LEAK (broke, and the settle rung did not give it back); BACKLOG (broke while driving, drained at rest); UNSETTLED (no settle rung to tell the two apart); UNVERIFIED (0 everywhere and nothing showed the probe can see the population); ERROR. A PASS from a judge that has never been seen red is unproven.',
    {
      run_dir: z.string().describe("A leak-hunt round's output directory."),
      invariants: z
        .array(z.record(z.unknown()))
        .optional()
        .describe(INVARIANTS_ARG_DESCRIPTION),
      invariants_file: z
        .string()
        .optional()
        .describe(INVARIANTS_FILE_ARG_DESCRIPTION),
      prelude: z
        .string()
        .optional()
        .describe(
          "Source run before every probe, for shared helpers. Overrides the spec file's `prelude`.",
        ),
      timeout_ms: z
        .number()
        .optional()
        .describe(
          'Per-rung probe timeout. Defaults to a value scaled from the largest rung.',
        ),
      max_nodes: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(20000000)
        .describe('Per-rung node-visit budget for full-heap walks.'),
      max_file_size_mb: z
        .number()
        .optional()
        .describe('Per-file size ceiling, matching memlab_load_snapshot.'),
    },
    async ({
      run_dir,
      invariants,
      invariants_file,
      prelude,
      timeout_ms,
      max_nodes,
      max_file_size_mb,
    }) => {
      try {
        const spec = resolveInvariantSpec({
          invariants,
          invariants_file,
          prelude,
          run_dir,
        });
        const manifest = loadRunManifest(run_dir);
        const settlePath =
          manifest.settleRungPath != null &&
          snapshotExists(manifest.settleRungPath)
            ? manifest.settleRungPath
            : null;
        const {rungs, largestMB} = resolveRungs(
          [...manifest.paths, ...(settlePath != null ? [settlePath] : [])],
          max_file_size_mb,
        );
        const timeoutMs = scaledTimeoutMs(largestMB, timeout_ms);
        const ladder = rungs
          .slice(0, manifest.paths.length)
          .map(r => r.localPath);
        const settleLocal =
          settlePath != null ? rungs[rungs.length - 1].localPath : null;
        const m = await measureJudges(
          spec,
          ladder,
          settleLocal,
          timeoutMs,
          max_nodes,
          // Per rung: the budget is a wall clock, and one allowance for the
          // whole ladder would starve the settle rung, which matters most.
          () => armScanBudgetFor(timeoutMs),
        );

        const results = spec.invariants.map(inv => ({
          inv,
          series: m.series.get(inv.name) ?? [],
          settle: m.settle.get(inv.name) ?? null,
          outcome: judgeSeries(
            inv,
            m.series.get(inv.name) ?? [],
            manifest.cyclesPerRung,
            m.settle.get(inv.name) ?? null,
            inv.visibilityProbe != null
              ? (m.visible.get(inv.name) ?? false)
              : null,
            m.errors.get(inv.name) ?? null,
          ),
        }));
        const counts = new Map<JudgeVerdict, number>();
        for (const r of results) {
          counts.set(
            r.outcome.verdict,
            (counts.get(r.outcome.verdict) ?? 0) + 1,
          );
        }
        const rows = results.map(r => [
          r.inv.name,
          r.inv.expect,
          r.series.map(v => (v == null ? '—' : formatNumber(v))).join(' → '),
          settlePath == null
            ? 'n/a'
            : r.settle == null
              ? '—'
              : formatNumber(r.settle),
          `**${r.outcome.verdict}** (${r.outcome.reason})`,
        ]);
        const name = run_dir.replace(/\/+$/, '').replace(/^.*\//, '');
        return toolResult(
          [
            `## Judges — ${name}`,
            '',
            `_${spec.invariants.length} invariant(s) from ${spec.source}; ${manifest.paths.length} driven rung(s) at cycles ${manifest.cyclesPerRung.join('/')}${settlePath != null ? ' + the settle rung' : ''}._`,
            ...(settlePath == null
              ? [
                  '',
                  '⚠ **UNSETTLED round**: no settle rung, so no judge can tell a leak from in-flight backlog. Re-drive with `--settle-minutes 7`.',
                ]
              : []),
            ...(spec.dropped.length > 0
              ? ['', `⚠ Not judged: ${spec.dropped.join('; ')}`]
              : []),
            '',
            markdownTable(
              ['Judge', 'Expect', 'Per rung', 'At rest', 'Verdict'],
              rows,
            ),
            '',
            `**Summary:** ${ORDER.filter(v => counts.has(v))
              .map(v => `${counts.get(v)} ${v}`)
              .join(' · ')}`,
            ...(results.some(r => r.inv.words != null)
              ? [
                  '',
                  '### What each judge claims',
                  '',
                  ...results
                    .filter(r => r.inv.words != null)
                    .map(r => `- **${r.inv.name}** — ${r.inv.words}`),
                ]
              : []),
            '',
            counts.has('PASS')
              ? '_A PASS says the judge did not fire, not that it can. It is unproven until the judge has been seen red: with its fix switched off, or on a round known to carry the leak._'
              : '',
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
