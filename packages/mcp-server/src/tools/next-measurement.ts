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
import {listSnapshots} from '../heap-state.js';
import {errorResult, formatNumber, toolResult} from '../utils.js';

/**
 * What the evidence on hand cannot support, and what capture would fix it.
 *
 * Every wrong conclusion in a leak hunt has the same shape: a claim that needed
 * a measurement nobody took, argued instead from one that was available. One
 * rung cannot show a trend. Two rungs cannot separate backlog from retention.
 * A ladder with no idle rung cannot either. A light snapshot cannot support any
 * statement about retention at all. None of these limits is visible in the
 * output of the tools that produce the numbers, so they get crossed silently.
 *
 * This is deliberately rule-based over what is actually resident, not a model
 * of the investigation: it reports gaps it can verify, and says nothing about
 * the ones it cannot see.
 */
interface Gap {
  severity: 'blocking' | 'limiting' | 'note';
  claim: string;
  why: string;
  fix: string;
}

export function registerNextMeasurement(server: McpServer): void {
  server.tool(
    'memlab_next_measurement',
    'What can the snapshots currently loaded actually support — and which capture would change that?\n\n' +
      'Every wrong conclusion in a leak hunt has the same shape: a claim that needed a measurement nobody took, argued from one that happened to be available. One rung cannot show a trend. Two rungs cannot separate in-flight work from retention. A light snapshot cannot support any statement about retention at all. None of those limits appears in the output of the tools that produce the numbers.\n\n' +
      'Reports the gaps in the CURRENT evidence base, worst first, each with the specific capture or call that closes it. It only reports gaps it can verify from what is resident — it is not a model of your investigation, and silence about something is not endorsement of it.',
    {
      goal: z
        .enum(['find-leak', 'size-fix', 'verify-fix', 'any'])
        .optional()
        .default('any')
        .describe(
          'What the investigation is for, which changes which gaps matter: "find-leak" (is something growing), "size-fix" (how much would a fix save), "verify-fix" (did the fix work).',
        ),
    },
    async ({goal}) => {
      try {
        const resident = listSnapshots();
        const gaps: Gap[] = [];

        if (resident.length === 0) {
          return toolResult(
            'No snapshots are loaded, so there is no evidence base to assess. Load one with `memlab_load_snapshot` — and if the question is about growth, load the ladder rather than one capture.',
          );
        }

        const light = resident.filter(m => m.light);
        if (light.length > 0) {
          gaps.push({
            severity: 'blocking',
            claim:
              'anything about retention, ownership or "what would this free"',
            why: `${light.map(m => `\`${m.handle}\``).join(', ')} ${light.length === 1 ? 'was' : 'were'} loaded with \`light: true\`, which skips the path and dominator pass. Retained sizes read as 0 and there are no retainer paths — not "no leak", no data.`,
            fix: 'Reload without `light` (`memlab_load_snapshot({file_path, light: false})`).',
          });
        }

        if (resident.length === 1) {
          gaps.push({
            severity: 'blocking',
            claim: 'that anything is GROWING',
            why: 'One capture is a state, not a trend. A large population in a single snapshot is equally consistent with a steady-state working set and with an accumulation — nothing in the capture distinguishes them.',
            fix: 'Capture a second rung after exercising the suspect flow, load it with `keep_previous: true`, then `memlab_diff_snapshots` or `memlab_sequence_analysis`. `memlab_growth_signals` is the single-snapshot substitute, and it is a heuristic.',
          });
        }

        if (resident.length === 2) {
          gaps.push({
            severity: 'limiting',
            claim: 'that growth is a LEAK rather than backlog',
            why: 'Two rungs cannot separate in-flight work from retention. A burst of activity legitimately inflates promise chains, IndexedDB transactions, scheduler queues and request buffers, and every one of those looks exactly like an accumulation in a two-rung diff.',
            fix: 'Capture a third rung after the app goes idle and GC has run, then `memlab_settle_check({busy_handle, settled_handle})`. Anything that drains was backlog.',
          });
          gaps.push({
            severity: 'note',
            claim: 'that a per-step trend is monotonic',
            why: 'With two points "grew every step" and "grew overall" are the same statement, so a single GC-band sample reads as a trend.',
            fix: 'A third rung makes the trend verdicts in `memlab_sequence_analysis` mean something.',
          });
        }

        if (resident.length >= 3) {
          gaps.push({
            severity: 'note',
            claim: 'that the last rung is a settled one',
            why: 'A ladder of N rungs still cannot separate backlog from retention unless one of them was captured after the app went idle. Rung count is not the same as having a settle rung, and nothing in the ladder records which is which.',
            fix: 'If none of the rungs is post-idle, capture one. `memlab_settle_check` is what reads it.',
          });
        }

        if (goal === 'size-fix' || goal === 'any') {
          gaps.push({
            severity: 'note',
            claim: 'that a fix would free the bytes a class total shows',
            why: 'A class total counts memory other live code also holds, and summing per-object retained sizes double-counts every nested object. Neither is what a fix frees.',
            fix: '`memlab_what_if` for the dominator-deduped figure (add `cascade: true` for the second-order effect), and `memlab_unit_cost` for the per-instance number a cap is sized against.',
          });
        }

        if (goal === 'verify-fix') {
          gaps.push({
            severity: 'blocking',
            claim: 'that the fix is what changed the number',
            why: 'A before/after pair captured on different builds differs in more than the fix. Without knowing the gate state IN each capture, an improvement is attributed to the fix by assumption.',
            fix: '`memlab_app_config({key})` reads the flag out of each capture directly. Then `memlab_verify_fix` for the per-cycle rates, and `memlab_retainer_diff` to confirm the path you fixed is the one that changed.',
          });
        }

        if (goal === 'find-leak' || goal === 'any') {
          gaps.push({
            severity: 'note',
            claim: 'that a population is retained one way',
            why: 'The default retainer tools sample ~10 instances and stop early once they agree, so a minority path — often the interesting one — cannot appear.',
            fix: '`memlab_trace_all` traces the whole population and reports every cluster under 10% share.',
          });
          gaps.push({
            severity: 'note',
            claim: 'that a grower is production memory at all',
            why: 'Dev-tools bridges, DevTools console retention, a11y/CDP caches and React Fast Refresh all manufacture growth that survives GC and is rooted at the real Window.',
            fix: '`memlab_dev_artifacts({explain: true})` — the `explain` table also shows which families it did NOT find, so a silent zero is distinguishable from a clean capture.',
          });
        }

        const order = {blocking: 0, limiting: 1, note: 2} as const;
        gaps.sort((a, b) => order[a.severity] - order[b.severity]);

        const lines: string[] = [
          `## Evidence base: ${formatNumber(resident.length)} snapshot(s) resident`,
          '',
          resident
            .map(
              m =>
                `- \`${m.handle}\` — ${m.fileName}, ${formatNumber(m.nodeCount)} nodes${m.light ? ' ⚠ LIGHT (no retention data)' : ''}`,
            )
            .join('\n'),
          '',
          `### Gaps (goal: ${goal})`,
          '',
        ];
        for (const g of gaps) {
          const tag =
            g.severity === 'blocking'
              ? '**BLOCKING**'
              : g.severity === 'limiting'
                ? '**LIMITING**'
                : 'note';
          lines.push(
            `- ${tag} — cannot support: ${g.claim}`,
            `  - Why: ${g.why}`,
            `  - Closes it: ${g.fix}`,
          );
        }
        lines.push(
          '',
          '_Rule-based over what is resident. It cannot see what you have already concluded, and it does not know whether a rung was captured post-idle — so treat silence as "not checked", not "fine"._',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

/**
 * The one-line warning a report should carry when it rests on a single capture.
 *
 * `memlab_next_measurement` answers "what can this evidence support" well, and
 * nothing ever called it: no other tool's output says "you are one snapshot
 * short of being able to claim that", so the limitation is invisible at exactly
 * the moment a finding gets written down. A session that analysed one supplied
 * capture reported three findings as leaks; all three were standing sizes, and
 * two were structural costs that a rate would have separated immediately.
 *
 * Returns null when more than one snapshot is resident, so a real ladder is not
 * nagged.
 */
export function singleSnapshotCaveat(): string | null {
  if (listSnapshots().length > 1) return null;
  return (
    '> ⚠️ **One snapshot is resident, so everything above is a STANDING SIZE, not a rate.** ' +
    'A single capture cannot separate a leak from a structural O(owners) cost, cannot show a trend, and cannot verify a fix — ' +
    'a population that is large because the account is large looks identical to one that grows every cycle. ' +
    'Before calling anything here a leak, either capture a ladder (`memlab_leak_report` / `memlab_ladder_probe` over >=3 rungs) ' +
    'or establish the ratio with `memlab_population_vs_owners`, which answers structural-vs-accumulating from one capture. ' +
    'Run `memlab_next_measurement` for the full list of what this evidence base can and cannot support.'
  );
}
