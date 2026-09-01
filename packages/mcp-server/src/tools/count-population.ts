/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {tickAnalysis} from '../analysis-budget.js';
import {getSnapshot, getSnapshotByHandle} from '../heap-state.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  matchesPropertyShape,
  toolResult,
} from '../utils.js';

interface MethodResult {
  method: string;
  detail: string;
  count: number;
  sampleIds: number[];
}

/**
 * Count by every requested method in ONE pass over the node set.
 *
 * The tool exists to be called with several methods at once — the disagreement
 * between them is the signal — so a pass per method meant the common invocation
 * walked a multi-million-node graph up to three times. The matchers are
 * independent and all node-local, so they compose into a single walk at the cost
 * of the slowest one.
 */
function countAll(
  snapshot: IHeapSnapshot,
  opts: {className?: string; shape?: string[]; contextVar?: string},
): MethodResult[] {
  const {className, shape, contextVar} = opts;
  // Built once, not per node: rebuilding the matcher set inside the walk would
  // allocate one per node on a multi-million-node graph.
  const required = shape != null ? new Set(shape) : null;

  let classCount = 0;
  const classSamples: number[] = [];
  let shapeCount = 0;
  const shapeSamples: number[] = [];
  const contextTargets = new Set<number>();
  let contextEdges = 0;
  const contextSamples: number[] = [];

  snapshot.nodes.forEach(node => {
    tickAnalysis();
    if (node.id <= 3) return;
    if (className != null && node.name === className) {
      classCount++;
      if (classSamples.length < 3) classSamples.push(node.id);
    }
    if (required != null && matchesPropertyShape(node, required)) {
      shapeCount++;
      if (shapeSamples.length < 3) shapeSamples.push(node.id);
    }
    if (contextVar != null) {
      for (const edge of node.references) {
        if (edge.type !== 'context') continue;
        if (String(edge.name_or_index) !== contextVar) continue;
        contextEdges++;
        const target: IHeapNode | undefined = edge.toNode;
        if (target == null || target.id <= 3) continue;
        if (!contextTargets.has(target.id)) {
          contextTargets.add(target.id);
          if (contextSamples.length < 3) contextSamples.push(target.id);
        }
      }
    }
  });

  const results: MethodResult[] = [];
  if (className != null) {
    results.push({
      method: 'class',
      detail: `name === "${className}"`,
      count: classCount,
      sampleIds: classSamples,
    });
  }
  if (shape != null) {
    results.push({
      method: 'shape',
      detail: `carries all of {${shape.join(', ')}}`,
      count: shapeCount,
      sampleIds: shapeSamples,
    });
  }
  if (contextVar != null) {
    // Counted as "how many distinct objects are held under a context edge with
    // this name", which is the question a leak asks ("how many queues are there,
    // and are they the same one?"), not "how many closures capture it".
    //
    // This is the method the other two cannot substitute for. A variable
    // captured by a closure is not a property of any object — it lives in a V8
    // Context, reached by a `context` edge — so property and shape matching
    // return 0 against it, indistinguishably from the population not existing.
    // That silent zero has already produced a false negative on a real hunt: a
    // probe against React Scheduler's `timerQueue` read 0 at every rung of a
    // ladder while the population was in the tens of thousands.
    results.push({
      method: 'context_var',
      detail: `captured as \`${contextVar}\` (${formatNumber(contextEdges)} capturing closure(s))`,
      count: contextTargets.size,
      sampleIds: contextSamples,
    });
  }
  return results;
}

export function registerCountPopulation(server: McpServer): void {
  server.tool(
    'memlab_count_population',
    'Count one population by SEVERAL independent methods and report when they disagree.\n\n' +
      'Counting is the operation a leak hunt repeats most, and it is the one where a wrong answer is invisible: a ' +
      'method that cannot reach the population returns 0, which is byte-identical to the population not being there. ' +
      'Measured — a shape-based probe returned 0 at every rung against a closure-captured array holding tens of ' +
      'thousands of entries, and read as a clean negative.\n\n' +
      'So this counts by class name, by property shape, and by CLOSURE-CAPTURED VARIABLE name, whichever you supply, ' +
      'and treats disagreement between two methods as the headline result rather than a footnote. The context-variable ' +
      'method is the one nothing else offers: a variable captured by a closure is not a property of anything, so no ' +
      'amount of property or shape matching can see it.\n\n' +
      'Pass `expected_max` to check an observed population against a cap that is declared in SOURCE rather than ' +
      'visible in the heap — an LRU sized in code, a documented queue bound. One measured cache held 17,976 entries ' +
      'behind a nominal 1,000-entry cap, an 18x overrun that was found by accident.',
    {
      class_name: z
        .string()
        .optional()
        .describe(
          'Count instances whose constructor/class name matches exactly. Useless on anonymous records (their class is "Object") — use `shape` for those.',
        ),
      shape: z
        .array(z.string())
        .optional()
        .describe(
          'Count objects carrying ALL of these property names. The right method for anonymous object literals.',
        ),
      context_var: z
        .string()
        .optional()
        .describe(
          'Count distinct objects held under a CLOSURE-captured variable of this name. Use when the population lives in a closure rather than on an object — the case property and shape matching silently miss.',
        ),
      expected_max: z
        .number()
        .optional()
        .describe(
          'A cap this population is supposed to respect, from source or documentation. Reported as observed-vs-declared with the overrun ratio.',
        ),
      handle: z
        .string()
        .optional()
        .describe('Snapshot to measure (defaults to the active one).'),
    },
    async ({class_name, shape, context_var, expected_max, handle}) => {
      try {
        const snapshot =
          handle != null ? getSnapshotByHandle(handle) : getSnapshot();
        if (snapshot == null) {
          return errorResult(
            new Error(`Snapshot "${handle}" is not resident.`),
          );
        }

        const wantClass = class_name != null && class_name !== '';
        const wantShape = shape != null && shape.length > 0;
        const wantContext = context_var != null && context_var !== '';
        if (!wantClass && !wantShape && !wantContext) {
          return errorResult(
            new Error(
              'Pass at least one of `class_name`, `shape` or `context_var`. Passing two or more is the point — the disagreement between them is the signal.',
            ),
          );
        }
        const results = countAll(snapshot, {
          className: wantClass ? class_name : undefined,
          shape: wantShape ? shape : undefined,
          contextVar: wantContext ? context_var : undefined,
        });

        const lines: string[] = [
          '## Population count',
          '',
          markdownTable(
            ['Method', 'Matches', 'Count', 'Sample ids'],
            results.map(r => [
              `\`${r.method}\``,
              r.detail,
              formatNumber(r.count),
              r.sampleIds.length > 0
                ? r.sampleIds.map(id => `@${id}`).join(', ')
                : '—',
            ]),
            new Set([2]),
          ),
          '',
        ];

        const counts = results.map(r => r.count);
        const anyZero = counts.some(c => c === 0);
        const anyNonZero = counts.some(c => c > 0);

        if (results.length > 1) {
          const min = Math.min(...counts);
          const max = Math.max(...counts);
          if (anyZero && anyNonZero) {
            const blind = results.filter(r => r.count === 0).map(r => r.method);
            lines.push(
              `> ⚠️ **Methods disagree, and one of them found NOTHING.** ` +
                `\`${blind.join('`, `')}\` returned 0 while another method found ` +
                `${formatNumber(max)}. A method that cannot reach a population returns the ` +
                'same 0 as a population that is absent, so treat the zero as "this method is ' +
                'blind here", not as evidence. Whatever probe you were about to write, write it ' +
                'against the method that found something.',
              '',
            );
          } else if (max > 0 && max / Math.max(min, 1) >= 1.5) {
            lines.push(
              `> ⚠️ **Methods disagree by ${(max / Math.max(min, 1)).toFixed(1)}x** ` +
                `(${formatNumber(min)} vs ${formatNumber(max)}). They are counting different ` +
                'sets — a shape can match objects of several classes, and a class can contain ' +
                'several shapes. Decide which set the finding is about before quoting a number, ' +
                'and use the SAME method for every rung of a ladder.',
              '',
            );
          } else {
            lines.push(
              '_The methods agree, so the count is not an artifact of how it was measured._',
              '',
            );
          }
        } else {
          lines.push(
            counts[0] === 0
              ? '> ⚠️ **A single method returned 0, which is not a negative result.** Nothing here ' +
                  'distinguishes "the population is absent" from "this method cannot see it". Add a ' +
                  'second method — for a closure-held population that means `context_var`, which is ' +
                  'the one property and shape matching cannot substitute for.'
              : '_Counted by a single method. A second method is what turns this from a number into a ' +
                  'verified one._',
            '',
          );
        }

        if (expected_max != null) {
          // Per method, never a max across methods. The block above exists to
          // say these methods count DIFFERENT sets; picking the largest of them
          // and calling it "observed" measures the cap against a set it may not
          // govern, which prints a confident overrun that no code ever promised
          // to bound. The caller knows which set the cap is for; the tool's job
          // is to show each one against it rather than to guess.
          const ratioOf = (count: number): number =>
            expected_max > 0 ? count / expected_max : Infinity;
          const describe = (count: number): string => {
            const ratio = ratioOf(count);
            return ratio >= 1
              ? `**${ratio.toFixed(1)}x over**`
              : `${(ratio * 100).toFixed(0)}% of the cap`;
          };
          lines.push(
            `### Against the declared cap (${formatNumber(expected_max)})`,
            '',
          );
          if (results.length === 1) {
            lines.push(
              `Observed **${formatNumber(results[0].count)}** — ${describe(results[0].count)}.`,
              '',
            );
          } else {
            lines.push(
              markdownTable(
                ['Method', 'Count', 'Against the cap'],
                results.map(r => [
                  `\`${r.method}\``,
                  formatNumber(r.count),
                  describe(r.count),
                ]),
                new Set([1]),
              ),
              '',
              '_A cap governs ONE of these sets. The methods count different sets, so read the row for ' +
                'the method whose set the cap is written against — the others are context, not overruns._',
              '',
            );
          }
          const over = results.filter(r => ratioOf(r.count) >= 2);
          if (over.length > 0) {
            lines.push(
              `> ⚠️ **The cap is not bounding ${over.map(r => `\`${r.method}\``).join(', ')}.** ` +
                'Either it is applied to a different set than the one counted there (a cache that caps ' +
                'ENTRIES while each entry holds many objects), or it is not being enforced. Both are ' +
                'findings; they need different fixes, so establish which before writing one — ' +
                '`memlab_retainer_summary` on the sample ids above will show whether the cap’s owner is ' +
                'even on the retention path.',
              '',
            );
          }
        }

        lines.push(
          '_A count is not a rate. Feed the same method across a ladder with `memlab_ladder_probe` ' +
            '(and its `visibility_probe`) before calling anything a leak._',
        );

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
