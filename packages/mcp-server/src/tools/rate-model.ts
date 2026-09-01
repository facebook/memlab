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
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';
import {linearFit} from './ladder-probe.js';

interface SaturatingFit {
  /** Asymptote: where the population levels off. */
  plateau: number;
  /** Cycles to reach ~63% of the plateau — the implied retention window. */
  tau: number;
  r2: number;
}

/**
 * Fit `y = plateau * (1 - exp(-x / tau))`.
 *
 * `tau` enters non-linearly, so it is swept over a logarithmic grid and
 * `plateau` solved in closed form at each step (given tau the model is linear in
 * plateau). A grid rather than a gradient method on purpose: the objective has
 * flat regions on short ladders, four to eight points is the normal input, and a
 * sweep that always terminates is worth more here than one that converges
 * faster but can wander on a series with three usable rungs.
 */
function fitSaturating(xs: number[], ys: number[]): SaturatingFit {
  const maxX = Math.max(...xs);
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let ssTot = 0;
  for (const y of ys) ssTot += (y - meanY) * (y - meanY);

  let best: SaturatingFit = {plateau: 0, tau: maxX, r2: -Infinity};
  // From "saturates almost immediately" to "still effectively linear across the
  // whole ladder". Beyond ~10x the ladder length the curve is indistinguishable
  // from a straight line, which is the linear model's job to report.
  const STEPS = 160;
  const lo = Math.log(maxX / 200);
  const hi = Math.log(maxX * 10);
  for (let s = 0; s <= STEPS; s++) {
    const tau = Math.exp(lo + ((hi - lo) * s) / STEPS);
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
      const f = 1 - Math.exp(-xs[i] / tau);
      num += ys[i] * f;
      den += f * f;
    }
    if (den <= 0) continue;
    const plateau = num / den;
    let ssRes = 0;
    for (let i = 0; i < xs.length; i++) {
      const pred = plateau * (1 - Math.exp(-xs[i] / tau));
      ssRes += (ys[i] - pred) * (ys[i] - pred);
    }
    const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
    if (r2 > best.r2) best = {plateau, tau, r2};
  }
  return best;
}

export function registerRateModel(server: McpServer): void {
  server.tool(
    'memlab_rate_model',
    'Is this population UNBOUNDED, or is it a working set whose size is just a function of how fast the harness drove?\n\n' +
      'Fits both models to one series — a straight line, and a saturating curve `plateau * (1 - exp(-cycles/tau))` — ' +
      'and reports which the data actually supports, the implied plateau, and the implied retention window in cycles.\n\n' +
      'This is the distinction a short ladder cannot make and a long one makes for free. A population held by a ' +
      'time-boxed grace period (a temporary retain, a TTL cache, an in-flight window) is EXACTLY linear early — its ' +
      'size is rate x window and the window has not elapsed yet — so a 4,000-cycle ladder scores it r2 ~ 1.0 and it ' +
      'gets filed as an unbounded leak. Measured: one population read as linear at 4,000 cycles and plateaued by ' +
      '8,000, and the finding had to be downgraded twice. The plateau is the number that decides whether to file, and ' +
      'it is also the number that says what the population would be at a realistic interaction rate rather than at ' +
      'the ~10 interactions/second a hammer drives.\n\n' +
      'Feed it the series `memlab_ladder_probe` already produced; this does no snapshot work of its own.',
    {
      values: z
        .array(z.number())
        .min(3)
        .describe(
          'The measured population at each rung, in ladder order. At least three — two points fit both models perfectly and distinguish nothing.',
        ),
      cycles_per_rung: z
        .array(z.number())
        .min(3)
        .describe(
          'Cumulative interaction cycles at each rung, same length and order as `values`, non-decreasing. The real counts, not an even split: the whole comparison is against this axis.',
        ),
      label: z
        .string()
        .optional()
        .describe('Population name, used in the report header.'),
      harness_cycles_per_minute: z
        .number()
        .positive()
        .optional()
        .describe(
          'How fast the ladder was actually driven. Given this AND `production_cycles_per_minute`, the implied window is converted to time and the population is projected at the production rate — the figure that says whether this reproduces for a real user.',
        ),
      production_cycles_per_minute: z
        .number()
        .positive()
        .optional()
        .describe(
          'A realistic interaction rate for this surface. Used only for the projection described on `harness_cycles_per_minute`.',
        ),
    },
    async ({
      values,
      cycles_per_rung,
      label,
      harness_cycles_per_minute,
      production_cycles_per_minute,
    }) => {
      try {
        if (values.length !== cycles_per_rung.length) {
          return errorResult(
            new Error(
              `values has ${values.length} entries but cycles_per_rung has ${cycles_per_rung.length}; they describe the same rungs and must match.`,
            ),
          );
        }
        if (Math.max(...cycles_per_rung) <= 0) {
          return errorResult(
            new Error(
              'cycles_per_rung must contain a positive cycle count; a model against an all-zero axis is meaningless.',
            ),
          );
        }
        // Several guards below read the LAST rung as the furthest the ladder was
        // driven — `tau <= lastX` decides whether a plateau was observed or
        // extrapolated. On an out-of-order axis the last entry is not the
        // largest, so that comparison silently flips the verdict. Cumulative
        // cycle counts cannot decrease, so a decrease is a caller mistake worth
        // refusing rather than fitting.
        const outOfOrder = cycles_per_rung.findIndex(
          (x, i) => i > 0 && x < cycles_per_rung[i - 1],
        );
        if (outOfOrder > 0) {
          return errorResult(
            new Error(
              `cycles_per_rung must be in ladder order (non-decreasing cumulative cycles), but rung ${outOfOrder} ` +
                `is ${formatNumber(cycles_per_rung[outOfOrder])} after ${formatNumber(cycles_per_rung[outOfOrder - 1])}. ` +
                'Sort the rungs — and `values` with them — before modelling.',
            ),
          );
        }

        const lin = linearFit(cycles_per_rung, values);
        const sat = fitSaturating(cycles_per_rung, values);
        const last = values[values.length - 1];
        const lastX = cycles_per_rung[cycles_per_rung.length - 1];

        const lines: string[] = [
          `## Rate model — ${label != null ? `\`${label}\`` : 'population'}`,
          '',
          markdownTable(
            ['Model', 'Fit (r2)', 'Parameters'],
            [
              [
                'Unbounded (linear)',
                lin.r2.toFixed(4),
                `${lin.slope >= 0 ? '+' : ''}${lin.slope.toFixed(3)} per cycle`,
              ],
              [
                'Saturating',
                sat.r2.toFixed(4),
                `plateau ≈ ${formatNumber(Math.round(sat.plateau))}, window ≈ ${formatNumber(Math.round(sat.tau))} cycles`,
              ],
            ],
          ),
          '',
        ];

        // A saturating curve can always match a straight line by choosing a huge
        // tau, so it never fits WORSE by much and "saturating wins" needs a
        // margin to mean anything. The second test is the one that carries the
        // weight: if the ladder never got near the fitted plateau, the curve is
        // extrapolating a ceiling from data that does not contain one.
        const margin = sat.r2 - lin.r2;
        // The peak rather than the final rung: this test asks whether the DATA
        // got near the fitted ceiling, and a noisy dip at the last rung is not
        // evidence that it did not. On a clean series the two are the same
        // number.
        const peak = Math.max(...values);
        const reachedFraction = sat.plateau > 0 ? peak / sat.plateau : 0;
        const tauWithinLadder = sat.tau <= lastX;
        const saturates =
          margin > 0.02 && reachedFraction > 0.6 && tauWithinLadder;

        // A flat series fits a straight line PERFECTLY: `linearFit` short-
        // circuits to r2 = 1 when the values never vary, and a cleanly
        // decreasing series scores r2 ~ 1 too. Keying UNBOUNDED on r2 alone
        // therefore reported "consistent with a per-cycle leak ... at 0.000 per
        // cycle there is no ceiling in this data" for a population that never
        // moved. Growth has to be part of the test, not just fit quality.
        //
        // The 5% floor separates "did not move" from "moved"; it is not a
        // significance threshold, and both branches print the slope so the
        // reader can judge the size for themselves.
        const spanX =
          cycles_per_rung[cycles_per_rung.length - 1] - cycles_per_rung[0];
        const meanY = values.reduce((a, b) => a + b, 0) / values.length;
        const fittedRise = lin.slope * spanX;
        const grows =
          lin.slope > 0 && fittedRise > 0.05 * Math.max(Math.abs(meanY), 1);

        if (saturates) {
          lines.push(
            `**RATE-DRIVEN — this is a working set, not an unbounded leak.** The saturating model fits ` +
              `better (r2 ${sat.r2.toFixed(4)} vs ${lin.r2.toFixed(4)}), the ladder reached ` +
              `${(reachedFraction * 100).toFixed(0)}% of the fitted plateau, and the implied window ` +
              `(${formatNumber(Math.round(sat.tau))} cycles) falls INSIDE the ladder, so the levelling-off was ` +
              'observed rather than extrapolated.',
            '',
            `Steady state is about **${formatNumber(Math.round(sat.plateau))}**. The population is ` +
              'approximately `rate x window`: it grows linearly only while the window has not yet elapsed, which ' +
              'is why a short ladder scores it as a clean line. Size the window, not the slope.',
            '',
          );
        } else if (!grows) {
          lines.push(
            lin.slope < 0
              ? `**SHRINKING — this population goes DOWN across the ladder.** The fitted line falls by ` +
                  `${formatNumber(Math.round(Math.abs(fittedRise)))} (${lin.slope.toFixed(3)} per cycle) against a ` +
                  `mean level of ${formatNumber(Math.round(meanY))}. Neither model has a leak to describe here, and ` +
                  'note that a cleanly decreasing series fits a straight line at a high r2 — that fit is not ' +
                  'evidence of a leak.'
              : `**FLAT — this population is not growing with cycles.** Across the whole ladder the fitted line ` +
                  `rises by ${formatNumber(Math.round(fittedRise))} (+${lin.slope.toFixed(3)} per cycle) against a ` +
                  `mean level of ${formatNumber(Math.round(meanY))} — too little to call growth, so neither model ` +
                  'has a leak to describe. Note that a series which never varies fits a straight line at r2 ' +
                  '1.0000; that fit is not evidence of anything.',
            '',
            lin.slope < 0
              ? '_A shrinking population usually means the harness drained something, or the rungs are not ' +
                  'comparable — check that every rung ran the same combo before reading the trend._'
              : '_If a leak was expected here, the probe more likely cannot see the population than the ' +
                  'population is bounded: check with `memlab_count_population` on a second method._',
            '',
          );
        } else if (lin.r2 >= 0.98) {
          lines.push(
            `**UNBOUNDED — consistent with a per-cycle leak.** The straight line fits at r2 ${lin.r2.toFixed(4)}` +
              // Name the test that actually rejected saturation. Saying "the
              // saturating model does not do materially better" when it fit by a
              // clear margin and was rejected on reached-fraction contradicts the
              // table printed directly above it.
              (margin <= 0.02
                ? ' and the saturating model does not do materially better'
                : !tauWithinLadder
                  ? ` and the saturating model, though it fits better (r2 ${sat.r2.toFixed(4)}), wants a window of ` +
                    `${formatNumber(Math.round(sat.tau))} cycles — longer than the whole ladder, so it is fitting a line, not a curve`
                  : ` and the saturating model, though it fits better (r2 ${sat.r2.toFixed(4)}), is rejected because the ladder ` +
                    `only reached ${(reachedFraction * 100).toFixed(0)}% of its fitted plateau — a ceiling that far above the data is asserted, not observed`) +
              `. At ${lin.slope.toFixed(3)} per cycle there is no ceiling in this data.`,
            '',
          );
        } else {
          lines.push(
            `**INCONCLUSIVE.** Neither model is convincing (linear r2 ${lin.r2.toFixed(4)}, ` +
              `saturating r2 ${sat.r2.toFixed(4)}). The series is probably noisy, episodic, or ` +
              'driven by something other than cycle count. Read the per-rung deltas rather than either trend line.',
            '',
          );
        }

        if (!tauWithinLadder && margin > 0.02) {
          lines.push(
            `> ⚠️ The saturating fit wants a window of ${formatNumber(Math.round(sat.tau))} cycles, but the ladder ` +
              `only ran to ${formatNumber(lastX)}. A plateau beyond the last rung is an EXTRAPOLATION — this data ` +
              'cannot tell an unbounded leak from a working set that saturates later. Extend the ladder before ' +
              'trusting either verdict.',
            '',
          );
        }

        if (
          harness_cycles_per_minute != null &&
          production_cycles_per_minute != null
        ) {
          const windowMinutes = sat.tau / harness_cycles_per_minute;
          // Scale the fitted PLATEAU, not tau. A time-boxed population is
          // `rate_per_cycle x cycles_in_window`; at the production rate the same
          // time window holds `prod/harness` times as many cycles, so the
          // population scales by that ratio. Scaling tau instead drops the
          // per-cycle rate and silently returns a cycle COUNT — equal to the
          // population only when the rate happens to be 1 per cycle.
          const rateRatio =
            production_cycles_per_minute / harness_cycles_per_minute;
          const prodSteady = sat.plateau * rateRatio;
          lines.push(
            '### At a production interaction rate',
            '',
            `The implied window is ${formatNumber(Math.round(sat.tau))} cycles at ` +
              `${formatNumber(harness_cycles_per_minute)} cycles/min = **${windowMinutes.toFixed(1)} minutes**. ` +
              `At ${formatNumber(production_cycles_per_minute)} cycles/min a user would hold about ` +
              `**${formatNumber(Math.round(prodSteady))}** of these at steady state, against ` +
              `${formatNumber(Math.round(last))} measured here.`,
            '',
            '_A time-boxed population scales with the DRIVE RATE, so a hammer inflates it by exactly the ratio of ' +
              'the two rates. That is the number to quote when deciding whether this is worth fixing, not the ' +
              'measured peak._',
            '',
          );
          // The projection is only meaningful if the window it rests on was
          // measured. Under UNBOUNDED or INCONCLUSIVE the same tau was just
          // judged unreliable, so printing a confident steady state from it
          // contradicts the verdict above.
          if (!saturates) {
            lines.push(
              `> ⚠️ **This projection rests on a window the verdict above rejected.** The fit is not ` +
                'RATE-DRIVEN here, so `tau` and the plateau are unreliable — possibly extrapolated well beyond ' +
                'the ladder. Treat the number as an illustration of the rate ratio, not as a population a user ' +
                'would hold. Extend the ladder until the curve levels off before quoting it.',
              '',
            );
          }
        } else if (saturates) {
          lines.push(
            '_Pass `harness_cycles_per_minute` and `production_cycles_per_minute` to convert the window to time ' +
              'and project the steady state a real user would see — for a rate-driven population that projection ' +
              'is the finding._',
            '',
          );
        }

        lines.push(
          '_Both models are fitted to the numbers given; neither knows what retains the population. A saturating ' +
            'fit is evidence of a bound, not proof of one — confirm the mechanism (a TTL, a grace timer, an LRU ' +
            'cap) with `memlab_retainer_summary` before closing the finding._',
        );

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
