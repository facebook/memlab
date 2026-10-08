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
 * Calibrate judges against rounds known to carry the leaks they guard.
 *
 * A switch-off arm proves a judge only for leaks a gated fix exists for. The
 * rest are proven the way a detector is: keep the ladders of confirmed leaks,
 * and require every judge that claims to guard one to go red on it. A judge
 * that does not is BLIND, and the ledger makes `memlab_judges` say so next to
 * every PASS it prints afterwards.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {
  judgeFired,
  judgeRound,
  measureRound,
  resolveInvariantSpec,
  type CalibrationRound,
} from '../judges.js';
import {
  judgeFingerprint,
  ledgerPath,
  recordSightings,
} from '../judge-ledger.js';
import {errorResult, markdownTable, toolResult} from '../utils.js';
import {
  INVARIANTS_ARG_DESCRIPTION,
  INVARIANTS_FILE_ARG_DESCRIPTION,
} from './judges.js';

export function registerCalibrateJudges(server: McpServer): void {
  server.tool(
    'memlab_calibrate_judges',
    "Calibrate invariant judges against rounds KNOWN to carry the leaks they guard: each calibration round lists the judges that must go red on it, and a judge that stays green there is BLIND. Results go to a ledger keyed by what each judge measures (editing a probe invalidates its evidence; renaming it does not), and `memlab_judges` then shows, next to every verdict, whether that judge has been seen red. Rounds come from the invariants file's `calibration` section ([{run_dir, red: [judge names], note}]) or from `rounds`.",
    {
      rounds: z
        .array(
          z.object({
            run_dir: z
              .string()
              .describe('A round known to carry one or more leaks.'),
            red: z
              .array(z.string())
              .min(1)
              .describe('Judges that must go red on this round.'),
            note: z
              .string()
              .optional()
              .describe('Which leak the round carries, for the ledger.'),
          }),
        )
        .optional()
        .describe(
          "Calibration rounds. Overrides the invariants file's `calibration` section.",
        ),
      invariants: z
        .array(z.record(z.unknown()))
        .optional()
        .describe(INVARIANTS_ARG_DESCRIPTION),
      invariants_file: z
        .string()
        .optional()
        .describe(INVARIANTS_FILE_ARG_DESCRIPTION),
      run_dir: z
        .string()
        .optional()
        .describe(
          'Where to look for invariants.json when no `invariants_file` is given.',
        ),
      timeout_ms: z
        .number()
        .optional()
        .describe('Per-rung probe timeout. Defaults to a scaled value.'),
      max_nodes: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(20000000)
        .describe('Per-rung node-visit budget for full-heap walks.'),
    },
    async ({
      rounds,
      invariants,
      invariants_file,
      run_dir,
      timeout_ms,
      max_nodes,
    }) => {
      try {
        const spec = resolveInvariantSpec({
          invariants,
          invariants_file,
          run_dir,
        });
        const calibration: CalibrationRound[] =
          rounds != null
            ? rounds.map(r => ({
                runDir: r.run_dir,
                red: r.red,
                note: r.note ?? '',
              }))
            : spec.calibration;
        if (calibration.length === 0) {
          throw new Error(
            `no calibration rounds: add a \`calibration\` section to ${spec.source} ([{run_dir, red: [judge names], note}]) or pass \`rounds\`.`,
          );
        }
        const byName = new Map(spec.invariants.map(i => [i.name, i]));
        const unknown = calibration
          .flatMap(c => c.red)
          .filter(n => !byName.has(n));
        if (unknown.length > 0) {
          throw new Error(
            `calibration names judge(s) not in the invariants: ${[...new Set(unknown)].join(', ')}`,
          );
        }

        const rows: string[][] = [];
        const blind = new Set<string>();
        const red = new Set<string>();
        const sightings: Parameters<typeof recordSightings>[0] = [];
        const failed: string[] = [];
        // One timestamp for the whole call: this run's sightings are one batch,
        // and the ledger's latest batch is what decides seen-red.
        const batchAt = new Date().toISOString();
        for (const c of calibration) {
          const short = c.runDir.replace(/\/+$/, '').replace(/^.*\//, '');
          // Per round: one unreadable round must not cost the others their
          // evidence, which is only written after the loop.
          let round;
          try {
            round = await measureRound(
              {...spec, invariants: c.red.flatMap(n => byName.get(n) ?? [])},
              c.runDir,
              {timeoutMs: timeout_ms, maxNodes: max_nodes},
            );
          } catch (err) {
            failed.push(
              `${short}: ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
          for (const name of c.red) {
            const inv = byName.get(name);
            if (inv == null) continue;
            const outcome = judgeRound(inv, round);
            if (outcome.verdict === 'ERROR') {
              // The probe failed, so the round says nothing about the judge.
              rows.push([
                name,
                short,
                c.note || '—',
                `ERROR (${outcome.reason})`,
                'not judged',
              ]);
              continue;
            }
            const fired = judgeFired(outcome);
            (fired ? red : blind).add(name);
            sightings.push({
              fingerprint: judgeFingerprint(inv, spec.prelude),
              name,
              sighting: {
                kind: 'calibration',
                round: c.runDir,
                note: c.note,
                red: fired,
                at: batchAt,
              },
            });
            rows.push([
              name,
              short,
              c.note || '—',
              `${outcome.verdict} (${outcome.reason})`,
              fired ? '**RED** ✓' : '**BLIND**',
            ]);
          }
        }
        const notRecorded = await recordSightings(sightings);
        const listed = new Set(calibration.flatMap(c => c.red));
        const uncalibrated = spec.invariants
          .map(i => i.name)
          .filter(n => !listed.has(n));
        return toolResult(
          [
            '## Judge calibration',
            '',
            ...(notRecorded == null
              ? []
              : [
                  `⚠ Sightings NOT recorded in the judge ledger (${ledgerPath()}): ${notRecorded}. Re-run to record them.`,
                  '',
                ]),
            `_${calibration.length} known-leak round(s); ledger: \`${ledgerPath()}\`._`,
            '',
            markdownTable(
              ['Judge', 'Round', 'Carries', 'Verdict there', 'Result'],
              rows,
            ),
            '',
            ...(failed.length > 0
              ? [
                  `⚠ ${failed.length} round(s) could not be measured, so their judges were not calibrated: ${failed.join('; ')}`,
                  '',
                ]
              : []),
            blind.size > 0
              ? `⚠ **BLIND on a known leak: ${[...blind].join(', ')}.** Fix the probe (same access path as the leak's retainer, a visibility probe that shares it) before trusting any PASS from it.`
              : `Every listed judge went red on its known leak (${red.size}).`,
            ...(uncalibrated.length > 0
              ? [
                  '',
                  `UNCALIBRATED (no known-leak round lists them): ${uncalibrated.join(', ')}.`,
                ]
              : []),
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
