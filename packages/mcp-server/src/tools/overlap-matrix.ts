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
import type {IHeapSnapshot} from '@memlab/core';
import memlabCore from '@memlab/core';
import {z} from 'zod';
import {getSnapshot, getSnapshotByHandle} from '../heap-state.js';
import {
  boundedDominatorRetainedSize,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

const {NumericSet} = memlabCore;

/**
 * Retained size is reported PER CLASS, and a reader who wants the value of a fix
 * naturally adds the classes the fix would remove. That arithmetic is wrong
 * whenever the classes sit on the same retention chain, and nothing in the
 * per-class output says so.
 *
 * Measured: on one capture `memlab_unit_cost` reported `RelayReplaySubject` at
 * 16.6 MB and `unsubscribe` at 16.6 MB. Summing them gives 33.2 MB. The real
 * combined figure was ~16.6 MB — they are largely the SAME bytes, reached
 * through different dominators, because the closures are retained by the
 * subjects. A fix sized off the sum would have been justified at roughly twice
 * its actual value.
 *
 * Overlap is computed by inclusion-exclusion over the same dominator-deduped
 * measure the other tools use: |A ∩ B| = retained(A) + retained(B) − retained(A ∪ B).
 * Deriving it from the union rather than from a per-byte set keeps one
 * definition of "retained" across the whole server — a second definition here
 * would make this tool's totals disagree with `unit_cost` on the same input,
 * which is precisely the confusion it exists to remove.
 */
function idsForClass(snapshot: IHeapSnapshot, className: string): number[] {
  const ids: number[] = [];
  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;
    if (node.name === className) ids.push(node.id);
  });
  return ids;
}

function retainedOf(
  snapshot: IHeapSnapshot,
  ids: number[],
): {retained: number; exact: boolean} {
  if (ids.length === 0) return {retained: 0, exact: true};
  return boundedDominatorRetainedSize(new NumericSet(ids), snapshot);
}

export function registerOverlapMatrix(server: McpServer): void {
  server.tool(
    'memlab_overlap_matrix',
    'Do these classes retain the SAME bytes? Reports pairwise overlap in dominator-deduped retained size, plus the ' +
      'combined deduped total for the whole set.\n\n' +
      'Use before quoting the value of a fix that removes more than one class. Per-class retained sizes are reported ' +
      'independently, so adding them is the obvious move and it double-counts every byte the classes share — which is ' +
      'the normal case for objects on one retention chain (a subject and the closures it holds, a record and its backing ' +
      'array). One measured pair reported 16.6 MB and 16.6 MB separately and ~16.6 MB combined; the naive sum overstated ' +
      'the fix by 2x.\n\n' +
      'Also answers the inverse question: near-zero overlap means the populations are genuinely independent, so a fix ' +
      'that removes one leaves the other untouched.',
    {
      classes: z
        .array(z.string())
        .min(2)
        .max(8)
        .describe(
          'Class/constructor names exactly as reported by memlab_class_histogram. Two to eight; every unordered pair is measured.',
        ),
      handle: z
        .string()
        .optional()
        .describe('Snapshot to measure (defaults to the active one).'),
    },
    async ({classes, handle}) => {
      try {
        const snapshot =
          handle != null ? getSnapshotByHandle(handle) : getSnapshot();
        if (snapshot == null) {
          return errorResult(
            new Error(`Snapshot "${handle}" is not resident.`),
          );
        }

        const unique = [...new Set(classes)];
        if (unique.length < 2) {
          return errorResult(
            new Error(
              'Pass at least two DISTINCT class names; overlap of a class with itself is always total.',
            ),
          );
        }

        const ids = new Map<string, number[]>();
        const solo = new Map<string, {retained: number; exact: boolean}>();
        for (const name of unique) {
          const classIds = idsForClass(snapshot, name);
          ids.set(name, classIds);
          solo.set(name, retainedOf(snapshot, classIds));
        }

        const present = unique.filter(n => (ids.get(n) ?? []).length > 0);
        const absent = unique.filter(n => (ids.get(n) ?? []).length === 0);

        const lines: string[] = ['## Retained-size overlap', ''];

        if (absent.length > 0) {
          lines.push(
            `_No instances found for: ${absent.map(n => `\`${n}\``).join(', ')}. ` +
              'A class name that matches nothing overlaps with nothing, which is not the same ' +
              'as being independent — check the name against `memlab_class_histogram`._',
            '',
          );
        }
        if (present.length < 2) {
          return errorResult(
            new Error(
              `Only ${present.length} of the requested classes have instances in this snapshot, so no pair can be compared.`,
            ),
          );
        }

        lines.push(
          markdownTable(
            ['Class', 'Instances', 'Retained (alone)'],
            present.map(n => [
              `\`${n}\``,
              formatNumber((ids.get(n) as number[]).length),
              `${solo.get(n)?.exact === false ? '~' : ''}${formatBytes(solo.get(n)?.retained ?? 0)}`,
            ]),
          ),
          '',
        );

        const pairRows: string[][] = [];
        let maxOverlapPct = 0;
        for (let i = 0; i < present.length; i++) {
          for (let j = i + 1; j < present.length; j++) {
            const a = present[i];
            const b = present[j];
            const ra = solo.get(a)?.retained ?? 0;
            const rb = solo.get(b)?.retained ?? 0;
            // `concat`, never `[...a, ...b]`. Spreading an id array into an
            // array literal passes every element as an argument, and a class
            // with ~800k instances (`Object` on a real heap) exceeds the
            // engine's argument limit and throws "Maximum call stack size
            // exceeded" — measured on a 7.1M-node capture, where this tool
            // crashed outright rather than degrading.
            const union = retainedOf(
              snapshot,
              (ids.get(a) as number[]).concat(ids.get(b) as number[]),
            );
            // Inclusion-exclusion. Clamped at zero because the bounded
            // dominator walk can truncate on pathologically deep chains, and a
            // truncated union can come back marginally larger than the parts —
            // a negative "overlap" would read as a fact about the heap when it
            // is an artifact of the walk cap.
            const shared = Math.max(0, ra + rb - union.retained);
            const smaller = Math.min(ra, rb);
            const pct = smaller === 0 ? 0 : (shared / smaller) * 100;
            maxOverlapPct = Math.max(maxOverlapPct, pct);
            pairRows.push([
              `\`${a}\` ∩ \`${b}\``,
              formatBytes(shared),
              `${pct.toFixed(1)}%`,
              formatBytes(union.retained),
            ]);
          }
        }

        lines.push(
          markdownTable(
            ['Pair', 'Shared bytes', '% of smaller', 'Union (deduped)'],
            pairRows,
          ),
          '',
        );

        // Same argument-limit hazard as the pairwise union above: `push(...arr)`
        // on a class with hundreds of thousands of instances overflows the stack.
        let allIds: number[] = [];
        for (const n of present) allIds = allIds.concat(ids.get(n) as number[]);
        const combined = retainedOf(snapshot, allIds);
        const naiveSum = present.reduce(
          (acc, n) => acc + (solo.get(n)?.retained ?? 0),
          0,
        );
        const inflation =
          combined.retained === 0 ? 0 : naiveSum / combined.retained;

        lines.push(
          `**Naive sum of the per-class figures: ${formatBytes(naiveSum)}.** ` +
            `**Actual combined, deduped: ${combined.exact ? '' : '~'}${formatBytes(combined.retained)}.**`,
          '',
        );
        // Two independent triggers, because one of them alone stays silent on a
        // case that plainly needs the warning. Inflation is computed over the
        // WHOLE set, so a small class almost entirely contained in a large one
        // barely moves it: measured, `(object properties)` overlapped `Object`
        // by 71.7% of its own size and the naive sum was still only 1.12x the
        // deduped total, so a threshold on inflation alone said nothing. Anyone
        // adding those two rows is double-counting most of the smaller one.
        const HEAVY_PAIR_OVERLAP_PCT = 25;
        if (inflation >= 1.2 || maxOverlapPct >= HEAVY_PAIR_OVERLAP_PCT) {
          lines.push(
            `> ⚠️ **Do not sum these classes.** Adding the per-class numbers overstates the ` +
              `population by **${inflation.toFixed(2)}x** overall, and the heaviest pair shares ` +
              `**${maxOverlapPct.toFixed(1)}%** of the smaller side. Quote the combined figure ` +
              `(${formatBytes(combined.retained)}) when sizing a fix that removes all of them, ` +
              'and expect a fix that removes only one to free much less than its own row suggests — ' +
              'the shared bytes stay behind, held by whichever class remains. Note the two numbers ' +
              'answer different questions: overall inflation is what a total is off by, the pair ' +
              'percentage is what an individual class would fail to free.',
            '',
          );
        } else if (maxOverlapPct < 5) {
          lines.push(
            '_These populations are effectively independent (every pair overlaps by under 5% of ' +
              'the smaller side), so the per-class figures ARE additive and a fix to one does not ' +
              'move the others._',
            '',
          );
        }

        if (!combined.exact) {
          lines.push(
            '_At least one measurement hit the dominator-walk cap and is an upper bound (marked `~`). ' +
              'The overlap percentages are correspondingly approximate; the direction of the finding ' +
              'is reliable, the last digit is not._',
            '',
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
