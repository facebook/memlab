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
 * Decide which EXPERIMENT ARM a capture is in, from the heap itself.
 *
 * `memlab_app_config` answers this whenever the flag is resident in the
 * client-side registry. A large class of gate cannot be: anything scoped to a
 * server-side unit — an ad account, a page, a business — is evaluated before
 * the response is built and never ships its name to the client. The page is in
 * an arm; the heap holds no record of which one.
 *
 * Measured consequence: an A/B on an ad-account-scoped experiment had both arms
 * driven and captured, and arm membership was then asserted from which command
 * had been run rather than from evidence. That is exactly the circular
 * reasoning `memlab_app_config` was written to end, moved one level up.
 *
 * What the heap does hold is the CONSEQUENCE of the gate: the arm that took the
 * other branch built different objects. So the arm is read from a
 * discriminator — a class or object shape that exists in one capture and is
 * ABSENT from the other. Absence is the load-bearing word. Two captures of the
 * SAME arm differ in almost every count, so "3× more of these" is noise; only
 * a population that is entirely missing is evidence, and even that wants a
 * same-arm control before it is trusted.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
  withSnapshotAt,
} from '../snapshot-borrow.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  suggestionsSuppressed,
  toolResult,
} from '../utils.js';

const MAX_SHAPE_KEYS = 12;
const MAX_ROW_CHARS = 120;

/** A shape signature can be hundreds of characters wide; a table row cannot. */
function ellipsize(name: string): string {
  return name.length <= MAX_ROW_CHARS
    ? name
    : `${name.slice(0, MAX_ROW_CHARS - 1)}…`;
}

interface Census {
  classes: Map<string, number>;
  shapes: Map<string, number>;
}

/**
 * Class counts plus own-property shape signatures, in one pass.
 *
 * Shapes matter as much as class names because the interesting branch is often
 * "the same class, built with one more field" — a minified class name is
 * identical in both arms while the object grew a `cacheKey`.
 */
function census(snapshot: IHeapSnapshot): Census {
  const classes = new Map<string, number>();
  const shapes = new Map<string, number>();
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.id <= 3) return;
    classes.set(node.name, (classes.get(node.name) ?? 0) + 1);
    if (node.type !== 'object') return;
    // A Set, not an adjacent-duplicate check: property edges are not sorted
    // (the sort happens below, after collection), and an accessor pair emits
    // the same name twice non-adjacently. That put duplicate keys in a
    // signature and inflated the `+N` truncation count — two objects of the
    // same shape could then land in different buckets.
    const seen = new Set<string>();
    const keys: string[] = [];
    let extra = 0;
    for (const e of node.references) {
      if (e.type !== 'property') continue;
      const name = String(e.name_or_index);
      if (name === '__proto__') continue;
      if (seen.has(name)) continue;
      seen.add(name);
      if (keys.length < MAX_SHAPE_KEYS) keys.push(name);
      else extra++;
    }
    if (keys.length === 0) return;
    // Wide objects are TRUNCATED, not dropped. Dropping them excluded exactly
    // the populations a gate branch tends to differ in — components, view
    // models, class instances routinely carry more than a dozen own
    // properties — so the tool was blindest where it was most needed. The
    // truncation is marked so a signature is never read as a complete shape.
    keys.sort();
    const sig = `${node.name} {${keys.join(',')}${extra > 0 ? `,…+${extra}` : ''}}`;
    shapes.set(sig, (shapes.get(sig) ?? 0) + 1);
  });
  // Deliberately NOT pruned by the min-count threshold. Pruning both sides
  // turned "the other capture built 5 of these" into "the other capture built
  // none of them" — and absence is the whole claim this tool rests on. The
  // threshold is applied when a CANDIDATE is selected; the opposite side is
  // always read at its true count.
  return {classes, shapes};
}

interface Discriminator {
  name: string;
  here: number;
  there: number;
}

function discriminators(
  here: Map<string, number>,
  there: Map<string, number>,
  minCount: number,
): {
  onlyHere: Discriminator[];
  onlyThere: Discriminator[];
  skewed: Discriminator[];
} {
  const onlyHere: Discriminator[] = [];
  const onlyThere: Discriminator[] = [];
  const skewed: Discriminator[] = [];
  // One pass over the UNION, so every population is classified exactly once
  // and the threshold is applied to the population rather than to a side.
  // Iterating each map separately dropped the asymmetric case outright: with
  // `here = 3, there = 300` the first loop skipped it as too small and the
  // second only collected populations absent here, so a 100x discriminator
  // appeared in no bucket at all.
  const names = new Set<string>([...here.keys(), ...there.keys()]);
  for (const name of names) {
    const h = here.get(name) ?? 0;
    const t = there.get(name) ?? 0;
    // Both maps are unpruned, so a zero really is a zero — not a count that
    // fell below the threshold on the way in.
    if (Math.max(h, t) < minCount) continue;
    if (t === 0) onlyHere.push({name, here: h, there: 0});
    else if (h === 0) onlyThere.push({name, here: 0, there: t});
    else if (h >= t * 10 || t >= h * 10) skewed.push({name, here: h, there: t});
  }
  const byMagnitude = (a: Discriminator, b: Discriminator): number =>
    Math.max(b.here, b.there) - Math.max(a.here, a.there);
  onlyHere.sort(byMagnitude);
  onlyThere.sort(byMagnitude);
  skewed.sort(byMagnitude);
  return {onlyHere, onlyThere, skewed};
}

interface Row extends Discriminator {
  kind: 'class' | 'shape';
}

/**
 * Combine class-level and shape-level discriminators into one ranked list.
 *
 * A shape signature begins with its class name, so a class row and the shape
 * rows under it describe the SAME objects. Concatenating both listed one
 * population two or three times and made a single discriminator look like
 * several — which, in a tool whose whole output is "how much evidence is
 * there", is the one error that changes the conclusion. When the class itself
 * is a discriminator the shape rows add nothing, so they are dropped; when it
 * is not, the shape rows are the finding and are kept, marked as refinements.
 */
function mergeRows(
  classRows: readonly Discriminator[],
  shapeRows: readonly Discriminator[],
  by: (d: Discriminator) => number,
): Row[] {
  const classNames = new Set(classRows.map(r => r.name));
  const rows: Row[] = classRows.map(r => ({...r, kind: 'class' as const}));
  for (const r of shapeRows) {
    // `-1` would slice off the last character and dedupe against a class name
    // that does not exist — a silent mis-merge. A signature that does not look
    // like one is kept rather than matched against a guess.
    const brace = r.name.indexOf(' {');
    const cls = brace >= 0 ? r.name.slice(0, brace) : null;
    if (cls != null && classNames.has(cls)) continue;
    rows.push({...r, kind: 'shape'});
  }
  return rows.sort((a, b) => by(b) - by(a));
}

export function registerGateFingerprint(server: McpServer): void {
  server.tool(
    'memlab_gate_fingerprint',
    'Decide which EXPERIMENT ARM the loaded capture is in by comparing it against a capture of the other arm, for gates `memlab_app_config` cannot read. Any experiment scoped to a server-side unit — an ad account, a page, a business — is evaluated before the response is built and never ships its name to the client, so the heap holds no flag to read: arm membership then gets asserted from which command was run rather than from evidence, which is the circular reasoning `memlab_app_config` exists to end. This reads the arm from its CONSEQUENCE instead — a class or object shape present in one capture and ABSENT from the other. Absence is the load-bearing word: two captures of the SAME arm differ in nearly every count, so a 3x difference is noise and only a missing population is evidence. Returns candidate discriminators ranked by size, plus the same-arm control that has to be run before any of them is trusted.',
    {
      compare: z
        .string()
        .describe(
          'Path to a snapshot of the OTHER arm, captured through the same combo at the same cycle count. A capture from a different combo is not comparable — the difference will be the combo, not the gate.',
        ),
      min_count: z
        .number()
        .optional()
        .default(20)
        .describe(
          'Minimum size for a population to be offered as a CANDIDATE (default 20). A class with 3 instances differs between any two captures. It does not filter the other side: a candidate reported as absent there really is absent, not merely below this number.',
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Rows per section (default 20).'),
    },
    async ({compare, min_count, limit}) => {
      try {
        const loaded = getSnapshot();
        const {rungs, largestMB} = resolveRungs([compare]);
        if (rungs.length === 0) {
          return errorResult(
            new Error(
              `\`compare\` resolved to no snapshot: ${compare}. Pass the path of the other arm's capture.`,
            ),
          );
        }
        armScanBudgetFor(scaledTimeoutMs(largestMB));
        const hereCensus = census(loaded);
        armScanBudgetFor(scaledTimeoutMs(largestMB));
        const thereCensus = await withSnapshotAt(rungs[0].localPath, snap =>
          census(snap),
        );

        const byClass = discriminators(
          hereCensus.classes,
          thereCensus.classes,
          min_count,
        );
        const byShape = discriminators(
          hereCensus.shapes,
          thereCensus.shapes,
          min_count,
        );

        const lines: string[] = [
          '## Arm discriminators',
          '',
          `_Loaded capture vs \`${rungs[0].label.replace(/^.*\//, '')}\`, populations of ${formatNumber(min_count)}+._`,
          '',
        ];

        const section = (title: string, rows: Row[], note: string): void => {
          lines.push(`### ${title}`, '');
          if (rows.length === 0) {
            lines.push('_None._', '');
            return;
          }
          lines.push(
            markdownTable(
              ['Population', 'Kind', 'Loaded', 'Compare'],
              rows
                .slice(0, limit)
                .map(r => [
                  ellipsize(r.name),
                  r.kind,
                  formatNumber(r.here),
                  formatNumber(r.there),
                ]),
              new Set([2, 3]),
            ),
            '',
            note,
            '',
          );
        };

        section(
          'Present only in the LOADED capture',
          mergeRows(byClass.onlyHere, byShape.onlyHere, r => r.here),
          '_These are the strongest arm evidence available: the other capture built none of them. A `shape` row is a population whose CLASS exists in both captures but whose object layout does not — count it as one discriminator, not as several._',
        );
        section(
          'Present only in the COMPARE capture',
          mergeRows(byClass.onlyThere, byShape.onlyThere, r => r.there),
          '_The mirror image. A branch that ADDS objects and one that REMOVES them are equally good discriminators, and which direction you get tells you which arm is which._',
        );
        section(
          'Skewed 10x or more (weaker)',
          mergeRows(byClass.skewed, byShape.skewed, r =>
            Math.max(r.here, r.there),
          ),
          '_Present in both, so this is a difference in DEGREE. Do not conclude an arm from these without the control below — cycle-count drift and ordinary run-to-run variance both reach 10x on small populations._',
        );

        lines.push(
          '**Before trusting any row above, run the same-arm control.**',
          '',
          'Capture the SAME arm twice through the same combo and pass the second capture ' +
            'here. Every population that also shows up as a discriminator in that run is ' +
            'run-to-run variance, not the gate, and has to be struck from the list. ' +
            'Without that subtraction this tool reports the noise floor as a finding.',
          '',
        );

        if (!suggestionsSuppressed('memlab_gate_fingerprint')) {
          lines.push(
            '**Suggested next steps**',
            '- `memlab_app_config({key: "<flag>"})` first if the gate is client-side after all — a direct read beats an inference.',
            '- `memlab_retainer_trace` on one instance of the top discriminator, to confirm it belongs to the gated code path rather than to something the two runs happened to do differently.',
            '- Record the outcome with `memlab_finding_index({action: "record", gate_state: "<on|off>"})` so a later round does not re-derive it.',
          );
        }
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
