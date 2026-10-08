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
  judgeRound,
  measureRound,
  resolveInvariantSpec,
  type JudgeVerdict,
} from '../judges.js';
import {
  describeSeenRed,
  judgeFingerprint,
  readLedger,
  seenRed,
} from '../judge-ledger.js';
import {
  describeSegments,
  ladderSegments,
  loadRunManifest,
  type LadderSegment,
} from '../run-manifest.js';
import {snapshotExists} from '../snapshot-index.js';
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
      segment: z
        .union([z.number().int().nonnegative(), z.literal('all')])
        .optional()
        .describe(
          'Which isolate segment to judge when the page reloaded mid-round (an A/B round reloads between its arms). Defaults to the LAST segment, which holds any settle rung. `"all"` judges the whole ladder as one heap.',
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
      segment,
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
        // A reload starts a new isolate (an A/B round reloads between its
        // arms), and one series across it compares two unrelated heaps. Judge
        // one segment: by default the last, which ends the round and so holds
        // any settle rung.
        const segments = ladderSegments(manifest);
        let chosen: LadderSegment[];
        if (segment === 'all') {
          chosen = segments;
        } else {
          const want = segment ?? segments.length - 1;
          const seg = segments[want];
          if (seg == null) {
            throw new Error(
              `no segment ${want}; this round has ${describeSegments(segments)}`,
            );
          }
          chosen = [seg];
        }
        const positions = chosen.flatMap(sg =>
          Array.from(
            {length: sg.lastRung - sg.firstRung + 1},
            (_, k) => sg.firstRung + k,
          ),
        );
        const round = await measureRound(spec, run_dir, {
          timeoutMs: timeout_ms,
          maxNodes: max_nodes,
          maxFileSizeMB: max_file_size_mb,
          positions,
        });
        const laterSegmentSettled =
          manifest.settleRungPath != null &&
          snapshotExists(manifest.settleRungPath) &&
          !positions.includes(manifest.paths.length - 1);
        const segmentNote =
          segments.length > 1 && segment !== 'all'
            ? `⚠ The page reloaded mid-round, so this judges segment ${chosen[0].index} of ${segments.length} (rungs ${chosen[0].firstRung}-${chosen[0].lastRung}). Pass \`segment\` for another.`
            : null;
        const settled = round.settled;
        const m = round.measurement;
        // Read once: one parse of the ledger per call, not one per judge.
        const ledger = readLedger();
        const results = spec.invariants.map(inv => ({
          inv,
          series: m.series.get(inv.name) ?? [],
          settle: m.settle.get(inv.name) ?? null,
          outcome: judgeRound(inv, round),
          seen: seenRed(judgeFingerprint(inv, spec.prelude), ledger),
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
          !settled ? 'n/a' : r.settle == null ? '—' : formatNumber(r.settle),
          `**${r.outcome.verdict}** (${r.outcome.reason})`,
          describeSeenRed(r.seen),
        ]);
        const unproven = results.filter(
          r => r.outcome.verdict === 'PASS' && r.seen.status !== 'red',
        );
        const name = run_dir.replace(/\/+$/, '').replace(/^.*\//, '');
        return toolResult(
          [
            `## Judges — ${name}`,
            '',
            `_${spec.invariants.length} invariant(s) from ${spec.source}; ${positions.length} driven rung(s) at cycles ${round.cycles.join('/')}${settled ? ' + the settle rung' : ''}._`,
            ...(segmentNote != null ? ['', segmentNote] : []),
            ...(!settled
              ? [
                  '',
                  // Only when a settle rung really exists AND belongs to a
                  // later segment; a missing or unreadable one on the last
                  // segment is an unsettled round, with the re-drive advice.
                  laterSegmentSettled
                    ? '⚠ **UNSETTLED segment**: the round settled, but its settle rung follows a later segment, so nothing here was captured at rest.'
                    : '⚠ **UNSETTLED round**: no settle rung, so no judge can tell a leak from in-flight backlog. Re-drive with `--settle-minutes 7`.',
                ]
              : []),
            ...(spec.dropped.length > 0
              ? ['', `⚠ Not judged: ${spec.dropped.join('; ')}`]
              : []),
            '',
            markdownTable(
              ['Judge', 'Expect', 'Per rung', 'At rest', 'Verdict', 'Seen red'],
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
            unproven.length > 0
              ? `⚠ **${unproven.length} PASS unproven** (${unproven.map(r => r.inv.name).join(', ')}): the judge has never been seen red, or was last seen BLIND. Prove it with \`memlab_calibrate_judges\` on a round known to carry the leak, or \`memlab_switch_matrix\` with its fix off.`
              : '',
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
