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
 * Switch a rule off, and the judge it guards must go red.
 *
 * A green judge says it did not fire, not that it can. The cheapest proof that
 * it can is a round where the fix it guards is switched off: if the judge stays
 * green there, it is blind, and every PASS it has printed is void. A fix behind
 * a gate already provides both arms, and the hunt runner's `--ab <prop>` drives
 * them on one account, so this reads either separate rounds or the two phases
 * of one A/B round.
 */

import fs from 'fs';
import path from 'path';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {
  judgeFired,
  judgeRound,
  measureRound,
  resolveInvariantSpec,
  type JudgeOutcome,
  type MeasuredRound,
} from '../judges.js';
import {
  judgeFingerprint,
  ledgerPath,
  recordSightings,
} from '../judge-ledger.js';
import {loadRunManifest} from '../run-manifest.js';
import {errorResult, markdownTable, toolResult} from '../utils.js';
import {
  INVARIANTS_ARG_DESCRIPTION,
  INVARIANTS_FILE_ARG_DESCRIPTION,
} from './judges.js';

interface ArmInput {
  run_dir: string;
  label?: string;
  off?: string[];
  ab_phase?: 'off' | 'on';
}

interface Arm {
  label: string;
  runDir: string;
  off: Set<string>;
  /** Positions into the round's rung list. */
  positions: number[];
  withSettle: boolean;
  /** The round settled after this arm, but the rung also holds the other phase. */
  settleWithheld: boolean;
}

/** The two phases of a `--ab` round, as positions into its rung list. */
function abPhases(
  runDir: string,
): {prop: string; off: number[]; on: number[]; splits: number[]} | null {
  // Same convention as loadRunManifest: a directory, or run.json itself.
  const file = runDir.endsWith('.json')
    ? runDir
    : path.join(runDir, 'run.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
    string,
    unknown
  >;
  const ab = raw.ab as Record<string, {prop?: unknown; rungs?: unknown}> | null;
  const rungs = Array.isArray(raw.rungs)
    ? (raw.rungs as Array<{index?: unknown}>)
    : [];
  if (ab == null || ab.off == null || ab.on == null) return null;
  const positionOf = (idx: unknown): number =>
    rungs.findIndex(r => r.index === idx);
  const toPositions = (list: unknown): number[] =>
    (Array.isArray(list) ? list : []).map(positionOf).filter(p => p >= 0);
  const prop = typeof ab.off.prop === 'string' ? ab.off.prop : null;
  if (prop == null) return null;
  return {
    prop,
    off: toPositions(ab.off.rungs),
    on: toPositions(ab.on.rungs),
    // run.json records rung INDICES, which stop matching positions once a
    // capture fails and its rung is skipped; compare positions with positions.
    splits: toPositions(raw.ladder_splits_after_rung),
  };
}

function resolveArms(inputs: ArmInput[]): Arm[] {
  return inputs.map((a, i) => {
    const manifest = loadRunManifest(a.run_dir);
    const all = manifest.paths.map((_, k) => k);
    const off = new Set(a.off ?? []);
    let positions = all;
    // Whether the settle rung measures THIS arm alone. For the second phase of
    // an A/B round that needs a reload between the phases: without one, what
    // the first phase retained is still on the heap at settle, and a working
    // fix would read red.
    let settleIsOwn = true;
    if (a.ab_phase != null) {
      const ab = abPhases(a.run_dir);
      if (ab == null) {
        throw new Error(
          `arm ${i} asks for ab_phase "${a.ab_phase}", but ${a.run_dir} is not an A/B round (no \`ab.off\` / \`ab.on\` in run.json).`,
        );
      }
      positions = a.ab_phase === 'off' ? ab.off : ab.on;
      if (a.ab_phase === 'off') off.add(ab.prop);
      // A reload between the OTHER phase and this one, whichever ran first.
      // With the other phase empty nothing else is on the heap; with this one
      // empty there is no arm to credit.
      const mine = a.ab_phase === 'off' ? ab.off : ab.on;
      const other = a.ab_phase === 'off' ? ab.on : ab.off;
      settleIsOwn =
        mine.length > 0 &&
        (other.length === 0 ||
          ab.splits.some(
            r => r >= Math.max(...other) && r < Math.min(...mine),
          ));
    }
    const lastPosition = all.length - 1;
    const dir = a.run_dir.endsWith('.json')
      ? path.dirname(a.run_dir)
      : a.run_dir;
    const name = dir.replace(/\/+$/, '').replace(/^.*\//, '');
    return {
      label:
        a.label ?? `${name}${a.ab_phase != null ? ` (${a.ab_phase})` : ''}`,
      // Resolved, so one round spelled two ways is measured once.
      runDir: path.resolve(a.run_dir),
      off,
      positions,
      // The settle rung follows the LAST driven rung, so it belongs only to
      // the arm that ends the round: an A/B round's first phase never rested.
      withSettle: positions.includes(lastPosition) && settleIsOwn,
      settleWithheld: positions.includes(lastPosition) && !settleIsOwn,
    };
  });
}

type Cell = 'red' | 'green' | 'amber' | 'void';

function cellOf(o: JudgeOutcome): Cell {
  if (o.verdict === 'LEAK') return 'red';
  if (o.verdict === 'PASS') return 'green';
  if (o.verdict === 'BACKLOG' || o.verdict === 'UNSETTLED') return 'amber';
  return 'void';
}

export function registerSwitchMatrix(server: McpServer): void {
  server.tool(
    'memlab_switch_matrix',
    "Prove the judges can go red: run every invariant judge (as `memlab_judges`) on several ARMS — rounds, or the two phases of one `--ab` round — where named rules (fixes, usually behind a gate) are switched off, and check that the judge each rule guards goes red with its rule off and stays green with it on. A judge that stays green with its rule off is BLIND, and every PASS it has printed is void. A rule never switched off is NOT SWITCHED, and a judge guarding no rule is UNPROTECTED; neither has been proven. Which judge a rule guards comes from each invariant's `rule` field, or from `protects`.",
    {
      arms: z
        .array(
          z.object({
            run_dir: z.string().describe("A round's output directory."),
            label: z.string().optional().describe('Column name for the arm.'),
            off: z
              .array(z.string())
              .optional()
              .describe('Rules switched OFF in this arm.'),
            ab_phase: z
              .enum(['off', 'on'])
              .optional()
              .describe(
                "For a `--ab` round: judge only this phase's rungs. `off` also marks the A/B prop as switched off.",
              ),
          }),
        )
        .min(1)
        .describe(
          'The arms to compare. An arm with nothing switched off is the control: every judge should PASS there.',
        ),
      protects: z
        .record(z.array(z.string()))
        .optional()
        .describe(
          "{rule: [judge names]}. Overrides the invariants' own `rule` fields.",
        ),
      invariants: z
        .array(z.record(z.unknown()))
        .optional()
        .describe(INVARIANTS_ARG_DESCRIPTION),
      invariants_file: z
        .string()
        .optional()
        .describe(
          `${INVARIANTS_FILE_ARG_DESCRIPTION} The default is read from the FIRST arm's round directory.`,
        ),
      prelude: z
        .string()
        .optional()
        .describe(
          "Source run before every probe, for shared helpers. Overrides the spec file's `prelude`.",
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
      max_file_size_mb: z
        .number()
        .optional()
        .describe('Per-file size ceiling, matching memlab_load_snapshot.'),
    },
    async ({
      arms: armInputs,
      protects,
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
          run_dir: armInputs[0].run_dir,
        });
        const arms = resolveArms(armInputs);

        // rule -> judges it guards
        const guards = new Map<string, string[]>();
        if (protects != null) {
          for (const [rule, judges] of Object.entries(protects)) {
            guards.set(rule, judges);
          }
        } else {
          for (const inv of spec.invariants) {
            if (inv.rule == null) continue;
            guards.set(inv.rule, [...(guards.get(inv.rule) ?? []), inv.name]);
          }
        }
        const known = new Set(spec.invariants.map(i => i.name));
        const unknown = [...guards.values()].flat().filter(j => !known.has(j));
        if (unknown.length > 0) {
          throw new Error(
            `\`protects\` names judge(s) not in the invariants: ${[...new Set(unknown)].join(', ')}`,
          );
        }

        // Each round is measured once, however many arms slice it.
        const measured = new Map<string, MeasuredRound>();
        for (const runDir of new Set(arms.map(a => a.runDir))) {
          measured.set(
            runDir,
            await measureRound(spec, runDir, {
              timeoutMs: timeout_ms,
              maxNodes: max_nodes,
              maxFileSizeMB: max_file_size_mb,
            }),
          );
        }
        const judge = (arm: Arm, inv: (typeof spec.invariants)[number]) => {
          const round = measured.get(arm.runDir);
          if (round == null) throw new Error(`${arm.runDir} was not measured`);
          return judgeRound(inv, round, arm);
        };
        const grid = spec.invariants.map(inv => arms.map(a => judge(a, inv)));

        const matrix = markdownTable(
          [
            'Judge',
            ...arms.map(
              a =>
                `${a.label}${a.off.size > 0 ? ` — off: ${[...a.off].join(', ')}` : ' — control'}`,
            ),
          ],
          spec.invariants.map((inv, i) => [
            inv.name,
            ...grid[i].map(o => `**${o.verdict}**`),
          ]),
        );

        const atRest = new Set(['returns-to-baseline', 'zero-at-rest']);
        const ruleRows: string[][] = [];
        const blind: string[] = [];
        const sightings: Parameters<typeof recordSightings>[0] = [];
        // One timestamp for the whole call: this run's sightings are one batch,
        // and the ledger's latest batch is what decides seen-red.
        const batchAt = new Date().toISOString();
        // judge -> every rule that guards it
        const rulesOf = new Map<string, string[]>();
        for (const [r, js] of guards) {
          for (const j of js) rulesOf.set(j, [...(rulesOf.get(j) ?? []), r]);
        }
        for (const [rule, judges] of guards) {
          const offArms = arms.filter(a => a.off.has(rule));
          for (const j of judges) {
            const i = spec.invariants.findIndex(inv => inv.name === j);
            // The comparison for "rule on" has EVERY rule guarding this judge
            // on: an arm with another of its fixes off is expected to be red.
            const onArms = arms.filter(
              a => !(rulesOf.get(j) ?? [rule]).some(r => a.off.has(r)),
            );
            const offCells = offArms.map(a => grid[i][arms.indexOf(a)]);
            const onCells = onArms.map(a => grid[i][arms.indexOf(a)]);
            let verdict: string;
            const redOff = offCells.filter(o => cellOf(o) === 'red').length;
            const greenOff = offCells.filter(o => cellOf(o) === 'green').length;
            // Fired at all, settle rung or not: a ladder that grew with the
            // rule off shows the judge can see the leak.
            const firedOff = offCells.filter(
              o => cellOf(o) === 'red' || judgeFired(o),
            ).length;
            if (offArms.length === 0) {
              verdict = 'NOT SWITCHED — no arm turns this rule off';
            } else if (
              greenOff > 0 &&
              firedOff === 0 &&
              onCells.some(o => cellOf(o) === 'red')
            ) {
              // Green with the rule off, red with it on: the judge can fire,
              // so it is not blind; the arms disagree with the claim instead.
              verdict =
                '**INVERTED** — red with the rule on, green with it off: the rule may cause what the judge measures, or the arms are mislabelled';
            } else if (greenOff > 0 && firedOff === 0) {
              // BLIND only when no off arm fired: a red arm proves the judge
              // can see the leak, and a green one beside it says that arm did
              // not exercise it (a short A/B phase that never crossed a bound).
              verdict =
                '**BLIND** — stayed green with its rule off; its PASSes are void';
              blind.push(j);
            } else if (onCells.some(o => cellOf(o) === 'red')) {
              // Before NOT RED: a judge firing with its fix in place is the
              // stronger fact, whatever the off arm did.
              verdict =
                '**RED WITH RULE ON** — fires with the fix in place: a real finding, or a judge stricter than the claim';
            } else if (redOff > 0) {
              // One red off arm proves the judge can fire; the others may lack
              // what that one had (an A/B round's first phase has no settle).
              verdict =
                redOff === offCells.length
                  ? '**PROVEN** — red with its rule off'
                  : `**PROVEN** — red with its rule off in ${redOff} of ${offCells.length} off arms${greenOff > 0 ? ` (green in ${greenOff}: those arms may not exercise the leak)` : ''}`;
            } else if (offCells.some(judgeFired)) {
              verdict =
                '**PROVEN (ladder only)** — grew with its rule off; that arm has no settle rung';
            } else if (
              offCells.some(o => o.unverifiedCause === 'short-ladder')
            ) {
              // A short arm, not a blind probe: one phase of a short A/B round
              // can hold fewer than 3 rungs, too few to tell a step from growth.
              verdict =
                'UNPROVEN — too few readable rungs in the off arm to judge growth; drive more cycles per arm';
            } else if (
              offCells.some(o => cellOf(o) === 'void') &&
              offCells
                .filter(o => cellOf(o) === 'void')
                .every(o => o.unverifiedCause === 'not-visible')
            ) {
              // UNVERIFIED is not "unjudgeable": the judge looked with its rule
              // off and saw nothing, which is the blindness this tool hunts.
              verdict =
                '**SAW NOTHING** — UNVERIFIED with its rule off: the probe (or its visibility control) cannot see the population there; fix it before trusting a PASS';
            } else if (offCells.some(o => cellOf(o) === 'void')) {
              verdict = 'UNPROVEN — the off arm could not be judged';
            } else if (offCells.some(o => o.verdict === 'BACKLOG')) {
              verdict =
                'NOT RED — with the rule off it only drained at rest: is the rule needed, or does the judge read the wrong population?';
            } else if (
              atRest.has(spec.invariants[i].expect) &&
              offArms.every(a => !a.withSettle)
            ) {
              verdict = `UNPROVEN — \`${spec.invariants[i].expect}\` is judged at rest, and no off arm has a settle rung (an A/B round's first phase never does). Prove it with a separate round driven with the rule off: \`{run_dir, off: ["${rule}"]}\`.`;
            } else {
              verdict = 'UNPROVEN';
            }
            // Only a decided switch is evidence, and each sighting is that
            // ARM's own result: a PROVEN judge records the arms where it fired,
            // a BLIND one the arms where it stayed green, so a mixed verdict
            // never writes a red sighting for a round where the judge was green.
            const proven = verdict.startsWith('**PROVEN');
            const isBlind = verdict.startsWith('**BLIND');
            if (proven || isBlind) {
              const inv = spec.invariants[i];
              offArms.forEach((arm, k) => {
                const cell = offCells[k];
                const fired = cellOf(cell) === 'red' || judgeFired(cell);
                if (proven ? !fired : cellOf(cell) !== 'green') return;
                sightings.push({
                  fingerprint: judgeFingerprint(inv, spec.prelude),
                  name: j,
                  sighting: {
                    kind: 'switch',
                    round: arm.runDir,
                    note: `${rule} off (${arm.label})`,
                    red: proven,
                    at: batchAt,
                  },
                });
              });
            }
            ruleRows.push([
              rule,
              j,
              offCells.map(o => o.verdict).join(', ') || '—',
              onCells.map(o => o.verdict).join(', ') || '—',
              verdict,
            ]);
          }
        }
        const notRecorded = await recordSightings(sightings);
        const guarded = new Set([...guards.values()].flat());
        const unprotected = spec.invariants
          .map(i => i.name)
          .filter(n => !guarded.has(n));
        const controlRed = arms
          .filter(a => a.off.size === 0)
          .flatMap(a =>
            spec.invariants
              .filter((inv, i) => cellOf(grid[i][arms.indexOf(a)]) === 'red')
              .map(inv => `${inv.name} in ${a.label}`),
          );

        return toolResult(
          [
            '## Switch matrix',
            '',
            ...(notRecorded == null
              ? []
              : [
                  `⚠ Sightings NOT recorded in the judge ledger (${ledgerPath()}): ${notRecorded}. Re-run to record them.`,
                  '',
                ]),
            `_${spec.invariants.length} judge(s) from ${spec.source}, ${arms.length} arm(s)._`,
            '',
            ...arms
              .filter(a => a.settleWithheld)
              .map(
                a =>
                  `⚠ ${a.label}: the settle rung is not credited to this arm — the page did not reload between the A/B phases, so it still holds what the first phase retained.\n`,
              ),
            ...(spec.dropped.length > 0
              ? [
                  `⚠ Not judged, so any rule they guard is missing below: ${spec.dropped.join('; ')}`,
                  '',
                ]
              : []),
            matrix,
            '',
            '### Each rule switched off',
            '',
            ruleRows.length > 0
              ? markdownTable(
                  ['Rule', 'Judge', 'Rule off', 'Rule on', 'Verdict'],
                  ruleRows,
                )
              : '_No judge names a rule. Add `rule` to the invariants, or pass `protects`._',
            '',
            ...(blind.length > 0
              ? [
                  `⚠ **${blind.length} BLIND judge(s): ${blind.join(', ')}.** Fix the judge before trusting any round it passed.`,
                  '',
                ]
              : []),
            ...(controlRed.length > 0
              ? [
                  `⚠ Red with every rule on: ${controlRed.join('; ')}. Either a leak no rule covers, or a judge stricter than its claim.`,
                  '',
                ]
              : []),
            ...(unprotected.length > 0
              ? [
                  `UNPROTECTED (no rule to switch off, so not proven here): ${unprotected.join(', ')}. Prove these on a round known to carry the leak.`,
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
