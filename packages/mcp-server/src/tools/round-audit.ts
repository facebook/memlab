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
import {z} from 'zod';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

export type CheckStatus = 'ok' | 'caveat' | 'blocking';

export interface AuditCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

interface RunManifest {
  run_id?: string;
  totals?: {cycles?: number; ok?: number; fail?: number};
  rungs?: Array<{index?: number; path?: string; isolate_restarted?: boolean}>;
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

const MIN_ANALYZABLE_RUNGS = 3;
const WEAK_STEP_RATE = 0.5;

/**
 * Decide whether a completed round can carry a conclusion.
 *
 * The recurring failure is not a round that fails — it is a round that LOOKS
 * complete and is not. One run reported `165 ok / 135 fail`, was written up as
 * valid, and had two of its ten declared operations at 58/165 and 0/165. Another
 * was split down the middle by a page reload and read as "the app shrank, the
 * cleanest round on record". Every signal needed to catch both is already in the
 * manifest; nothing was reading it.
 *
 * Split out as a pure function so the adjudication is testable without a run.
 */
export function auditManifest(m: RunManifest): {
  checks: AuditCheck[];
  verdict: 'TRUSTWORTHY' | 'CAVEATED' | 'UNTRUSTWORTHY';
} {
  const checks: AuditCheck[] = [];
  const rungs = m.rungs ?? [];

  checks.push(
    rungs.length >= MIN_ANALYZABLE_RUNGS
      ? {
          name: 'rung count',
          status: 'ok',
          detail: `${rungs.length} rungs — enough to separate a trend from a single GC-band sample.`,
        }
      : {
          name: 'rung count',
          status: 'blocking',
          detail:
            `${rungs.length} rung(s); ${MIN_ANALYZABLE_RUNGS} are needed. Two points make every series ` +
            'monotonic by construction. Record this round as UNANALYZED, not as "no leak".',
        },
  );

  const splits = m.ladder_splits_after_rung ?? [];
  const restarted = rungs.filter(r => r.isolate_restarted).length;
  checks.push(
    splits.length === 0 && restarted === 0
      ? {
          name: 'ladder continuity',
          status: 'ok',
          detail: 'One isolate throughout — all rungs are comparable.',
        }
      : {
          name: 'ladder continuity',
          status: 'blocking',
          detail:
            `The page reloaded after rung(s) ${splits.join(', ')} (${restarted} rung(s) flagged). ` +
            'Rungs across that boundary are DIFFERENT V8 isolates. Any delta spanning it is ' +
            'meaningless — analyze each segment on its own, or re-drive.',
        },
  );

  const steps = m.steps ?? {};
  const stepNames = Object.keys(steps);
  if (stepNames.length === 0) {
    checks.push({
      name: 'per-step landing',
      status: 'caveat',
      detail:
        'The combo declared no steps, so there is no evidence any particular surface was ' +
        'actually exercised — only that the cycle returned true. Declare `Combo.steps` to ' +
        'make coverage checkable.',
    });
  } else {
    const dead = stepNames.filter(n => (steps[n].landed ?? 0) === 0);
    const weak = stepNames.filter(
      n => (steps[n].landed ?? 0) > 0 && (steps[n].rate ?? 1) < WEAK_STEP_RATE,
    );
    const raised = stepNames.filter(n => (steps[n].errors ?? 0) > 0);
    if (dead.length > 0) {
      checks.push({
        name: 'per-step landing',
        status: 'blocking',
        detail:
          `${dead.length} declared step(s) NEVER landed: ${dead.join(', ')}. ` +
          'The ladder says nothing about those surfaces, however many cycles ran.',
      });
    } else if (weak.length > 0) {
      checks.push({
        name: 'per-step landing',
        status: 'caveat',
        detail:
          `${weak.length} step(s) landed below ${WEAK_STEP_RATE * 100}%: ` +
          weak
            .map(n => `${n} ${steps[n].landed}/${steps[n].attempted}`)
            .join(', ') +
          '. Those surfaces are barely exercised; scope the conclusion accordingly.',
      });
    } else {
      checks.push({
        name: 'per-step landing',
        status: 'ok',
        detail: `All ${stepNames.length} declared step(s) landed on the majority of cycles.`,
      });
    }
    if (raised.length > 0) {
      checks.push({
        name: 'step exceptions',
        status: 'caveat',
        detail:
          `${raised.length} step(s) RAISED at least once: ${raised.join(', ')}. ` +
          'An exception is a bug in the combo, not a fact about the app — check it before ' +
          'reading anything into that step.',
      });
    }
  }

  const mutators = m.mutates_content_per_cycle ?? [];
  checks.push(
    mutators.length === 0
      ? {
          name: 'content confound',
          status: 'ok',
          detail:
            'No combo added content while driving; a per-cycle rate is attributable.',
        }
      : {
          name: 'content confound',
          status: 'blocking',
          detail:
            `${mutators.join(', ')} added content DURING the ladder, so per-content and ` +
            'per-interaction growth are inseparable. A slope from this run is not attributable ' +
            'no matter how linear it is. Seed the content once up front and re-drive.',
        },
  );

  const gating = m.gating_verified ?? {};
  const gateKeys = Object.keys(gating);
  checks.push(
    gateKeys.length === 0
      ? {
          name: 'gating',
          status: 'caveat',
          detail:
            'No verified gating recorded. If the round depends on a flag being on or off, ' +
            'nothing here shows it actually was.',
        }
      : {
          name: 'gating',
          status: 'ok',
          detail: `${gateKeys.length} gating value(s) verified in-page.`,
        },
  );

  const totals = m.totals ?? {};
  const cycles = totals.cycles ?? 0;
  const ok = totals.ok ?? 0;
  const landRate = cycles > 0 ? ok / cycles : 0;
  checks.push(
    cycles === 0
      ? {
          name: 'cycle landing',
          status: 'blocking',
          detail: 'No cycles ran.',
        }
      : landRate >= WEAK_STEP_RATE
        ? {
            name: 'cycle landing',
            status: 'ok',
            detail: `${formatNumber(ok)}/${formatNumber(cycles)} cycles landed (${(landRate * 100).toFixed(0)}%).`,
          }
        : {
            name: 'cycle landing',
            status: 'caveat',
            detail: `only ${formatNumber(ok)}/${formatNumber(cycles)} cycles landed (${(landRate * 100).toFixed(0)}%).`,
          },
  );

  const caveats = m.caveats ?? [];
  if (caveats.length > 0) {
    checks.push({
      name: 'recorded caveats',
      status: 'caveat',
      detail: `${caveats.length} caveat(s) recorded by the runner — read them before concluding.`,
    });
  }

  const verdict = checks.some(c => c.status === 'blocking')
    ? 'UNTRUSTWORTHY'
    : checks.some(c => c.status === 'caveat')
      ? 'CAVEATED'
      : 'TRUSTWORTHY';
  return {checks, verdict};
}

const ICON: Record<CheckStatus, string> = {
  ok: '✅',
  caveat: '⚠️',
  blocking: '❌',
};

export function registerRoundAudit(server: McpServer): void {
  server.tool(
    'memlab_round_audit',
    "Read a leak hunt's `run.json` and say whether the round can carry a conclusion at all — BEFORE anyone reads its numbers. " +
      'Checks rung count, ladder continuity (a mid-run page reload silently splits the ladder into two V8 isolates), ' +
      'per-step landing (a declared surface that never actually opened), step exceptions, the content-mutation confound, ' +
      'verified gating, and the overall cycle landing rate.\n\n' +
      'Every one of these is already in the manifest and nothing was reading it. The failures this catches are rounds ' +
      'that LOOK complete: one was written up as valid with two of its ten declared operations at 58/165 and 0/165; ' +
      'another was split by a page reload and read as "the app shrank, cleanest round on record" when its valid segment ' +
      'said the opposite.\n\n' +
      'Returns TRUSTWORTHY / CAVEATED / UNTRUSTWORTHY. Run it first; `memlab_analyze_run` answers what the round MEASURED, ' +
      'this answers whether the round is worth measuring.',
    {
      run_dir: z
        .string()
        .describe(
          "Path to the hunt's output directory, or directly to its run.json.",
        ),
    },
    async ({run_dir}) => {
      try {
        const manifestPath = run_dir.endsWith('.json')
          ? run_dir
          : path.join(run_dir, 'run.json');
        if (!fs.existsSync(manifestPath)) {
          return errorResult(
            new Error(
              `No manifest at ${manifestPath}. Point at the hunt's output directory (the one containing run.json and snapshots/).`,
            ),
          );
        }
        const manifest = JSON.parse(
          fs.readFileSync(manifestPath, 'utf8'),
        ) as RunManifest;
        const {checks, verdict} = auditManifest(manifest);

        const lines: string[] = [
          `## Round audit — \`${manifest.run_id ?? path.basename(path.dirname(manifestPath))}\``,
          '',
          markdownTable(
            ['', 'Check', 'Finding'],
            checks.map(c => [ICON[c.status], c.name, c.detail]),
          ),
          '',
          `**Verdict: ${verdict}**`,
          '',
        ];
        if (verdict === 'UNTRUSTWORTHY') {
          lines.push(
            'At least one blocking problem means a conclusion drawn from this round would not be supported by it. ' +
              'Fix and re-drive, or scope the conclusion to the part of the ladder that is still valid — and say which part that is.',
          );
        } else if (verdict === 'CAVEATED') {
          lines.push(
            'Usable, but the caveats above have to travel with any number taken from it. A caveat dropped between ' +
              'the run and the write-up is how an unsupported claim gets recorded as a measurement.',
          );
        } else {
          lines.push(
            'No structural problem found. This says the round is well-formed, NOT that its findings are real — ' +
              'replication (`memlab_replicate`) and retainer evidence are separate questions.',
          );
        }
        if ((manifest.caveats ?? []).length > 0) {
          lines.push('', '### Caveats recorded by the runner', '');
          for (const c of manifest.caveats ?? []) lines.push(`- ${c}`);
        }
        return toolResult(lines.join('\n'), null);
      } catch (e) {
        return errorResult(e instanceof Error ? e : new Error(String(e)));
      }
    },
  );
}
