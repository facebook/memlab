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
 * Did this round's probes see an accumulator that is KNOWN to grow?
 *
 * A probe that returns 0 at every rung is either a clean surface or a blind
 * probe, and nothing in a flat ladder says which. Every round of one sweep
 * re-wrote the same check by hand (does `tracedInteractions` grow per
 * interaction?) before trusting a flat result. The app preset now declares
 * its controls, the runner copies them into run.json, and this measures them.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {linearFit} from './ladder-probe.js';
import {ladderShape} from '../ladder-shape.js';
import {loadRunManifest, type PositiveControl} from '../run-manifest.js';
import {
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
  withSnapshotAt,
} from '../snapshot-borrow.js';
import {countEntries} from './collection-trend.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/** Why a control cannot be measured as declared, or null. */
function misconfigured(c: PositiveControl): string | null {
  return c.kind === 'modulesMap-prefix' && (c.prefix ?? '') === ''
    ? 'modulesMap-prefix control has no `prefix`, so it would count every key'
    : null;
}

/**
 * Largest value the control takes over every holder of its edge. `found` and
 * `uncountable` (a map-size edge never on a collection) tell a declaration
 * error apart from a probe that saw no growth; both would read as a flat 0.
 */
function measure(
  snap: IHeapSnapshot,
  c: PositiveControl,
): {value: number; found: boolean; uncountable: boolean} {
  let best = 0;
  let matched = 0;
  let counted = 0;
  snap.nodes.forEach(node => {
    for (const e of node.references) {
      if (String(e.name_or_index) !== c.edge) continue;
      const t = e.toNode;
      matched++;
      if (c.kind === 'map-size') {
        const n = countEntries(t);
        if (n != null) {
          counted++;
          best = Math.max(best, n);
        }
      } else {
        let n = 0;
        for (const k of t.references) {
          if (String(k.name_or_index).startsWith(c.prefix ?? '')) n++;
        }
        best = Math.max(best, n);
      }
    }
  });
  return {
    value: best,
    found: matched > 0,
    uncountable: c.kind === 'map-size' && matched > 0 && counted === 0,
  };
}

export function registerPositiveControls(server: McpServer): void {
  server.tool(
    'memlab_positive_controls',
    'Measure the round\'s POSITIVE CONTROLS (run.json `positive_controls`, written by the leak-hunt runner from the app preset): known accumulators that should grow with interaction. PASS means the measurement can see growth, so a flat result elsewhere is a clean surface; FAIL means a probe or the drive is blind, and every flat result in the round is suspect. An idle round (a combo, or the round directory, named "idle") reports n/a.',
    {
      run_dir: z.string().describe("A leak-hunt round's output directory."),
    },
    async ({run_dir}) => {
      try {
        const manifest = loadRunManifest(run_dir);
        const controls = manifest.positiveControls;
        const dropped =
          manifest.droppedPositiveControls > 0
            ? `⚠ ${manifest.droppedPositiveControls} \`positive_controls\` entr${manifest.droppedPositiveControls === 1 ? 'y' : 'ies'} in run.json ${manifest.droppedPositiveControls === 1 ? 'is' : 'are'} malformed (needs \`name\`, \`edge\` and a \`kind\` of "map-size" or "modulesMap-prefix") and ${manifest.droppedPositiveControls === 1 ? 'was' : 'were'} not measured.`
            : null;
        if (controls.length === 0) {
          if (dropped != null) return toolResult(dropped);
          return toolResult(
            'This round declares no `positive_controls` in run.json. Add them to the app preset (`AppPreset.positive_controls`) so every round proves its probes can see growth.',
          );
        }
        // A token, not a substring: `spindle_0` is not an idle round.
        const idleToken = /(^|[^a-z])idle([^a-z]|$)/i;
        const idle =
          manifest.combos.some(c => idleToken.test(c)) ||
          idleToken.test(run_dir.replace(/\/+$/, '').replace(/^.*\//, ''));
        const {rungs, largestMB} = resolveRungs(manifest.paths);
        const series = controls.map(() => [] as Array<number | null>);
        // Per control, over the readable rungs: was its edge ever found, and
        // (map-size) ever on a collection?
        const found = controls.map(() => false);
        const countable = controls.map(() => false);
        const unreadable: string[] = [];
        for (const rung of rungs) {
          armScanBudgetFor(scaledTimeoutMs(largestMB));
          // Per rung: one unreadable rung leaves a gap in the ladder rather
          // than discarding every rung already measured.
          let values: Array<number | null>;
          try {
            values = await withSnapshotAt(rung.localPath, snap =>
              controls.map((c, i) => {
                if (misconfigured(c) != null) return 0;
                const m = measure(snap, c);
                if (m.found) found[i] = true;
                if (m.found && !m.uncountable) countable[i] = true;
                return m.value;
              }),
            );
          } catch (err) {
            unreadable.push(
              `${rung.label.replace(/^.*\//, '')}: ${String(err)}`,
            );
            values = controls.map(() => null);
          }
          values.forEach((v, i) => series[i].push(v));
        }
        const xs = manifest.cyclesPerRung;
        const rows = controls.map((c, i) => {
          const pts = series[i].flatMap((y, k) =>
            y == null ? [] : [{x: xs[k], y}],
          );
          // Growth past the first rung, not just a first-mount step: a
          // registry that fills once at mount and then holds proves nothing
          // about per-interaction accumulation. The slope is fitted past the
          // first rung, so a mount step neither passes nor inflates the
          // reported rate — which takes 3 readable rungs.
          const shape = ladderShape(series[i], xs);
          const after = pts.slice(1);
          const fit = linearFit(
            after.map(p => p.x),
            after.map(p => p.y),
          );
          const grows =
            (shape === 'LINEAR' ||
              shape === 'STEP+LINEAR' ||
              shape === 'SATURATING' ||
              shape === 'ONSET') &&
            after.length >= 2 &&
            after[after.length - 1].y > after[0].y;
          // Declaration errors, told apart from a probe that saw no growth.
          // Unknowable with no readable rung, and an idle round may never
          // create the collection at all.
          const anyRead = series[i].some(v => v != null);
          const bad =
            misconfigured(c) ??
            (!anyRead
              ? null
              : !found[i]
                ? idle
                  ? null
                  : `edge \`${c.edge}\` not found in any rung`
                : !countable[i]
                  ? `map-size edge \`${c.edge}\` is not on a Map, Set or Array`
                  : null);
          const verdict =
            bad != null
              ? `**FAIL** (${bad})`
              : idle
                ? 'n/a (idle round)'
                : pts.length < 3
                  ? '**FAIL** (fewer than 3 readable rungs, so a mount step cannot be told from growth)'
                  : grows && fit.slope > 0
                    ? `**PASS** (+${fit.slope.toFixed(3)}/cycle, ${shape})`
                    : `**FAIL** (${shape}: no per-interaction growth)`;
          return [
            c.name,
            series[i].map(v => (v == null ? '—' : formatNumber(v))).join(' → '),
            verdict,
          ];
        });
        const failed = rows.some(r => String(r[2]).includes('FAIL'));
        return toolResult(
          [
            '## Positive controls',
            '',
            ...(dropped != null ? [dropped, ''] : []),
            ...(unreadable.length > 0
              ? [
                  `⚠ ${unreadable.length} rung(s) could not be read and show as —: ${unreadable.join('; ')}`,
                  '',
                ]
              : []),
            markdownTable(['Control', 'Per rung', 'Verdict'], rows),
            '',
            failed
              ? '⚠ **A positive control did not grow.** Either the probe cannot see this population or the drive did not exercise it — treat every flat result in this round as unproven until that is explained.'
              : idle
                ? '_Idle round: controls are expected to stay flat here._'
                : '_Every control grew, so the measurement can see accumulation on this round._',
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
