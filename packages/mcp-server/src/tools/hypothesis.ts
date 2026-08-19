/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import vm from 'vm';
import {z} from 'zod';
import memlabHeapAnalysis from '@memlab/heap-analysis';
const {getFullHeapFromFile} = memlabHeapAnalysis;
import {resolveSnapshotPath} from './load-snapshot.js';
import {resolveLadderPaths} from './ladder.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';

// Property names used to fingerprint a shape, matching the other shape tools.
const SHAPE_PROP_CAP = 12;
// Shapes tracked per rung. Once this many distinct shapes are seen, tracking
// STOPS and the tail is uncounted (not folded into an "(other)" bucket) — the
// report says so explicitly. A heap with a million distinct shapes must not turn
// this into a memory problem of its own.
const MAX_SHAPES = 2000;

function shapeKey(node: IHeapNode): string {
  if (node.edge_count > 1024) return `${node.name} (too wide)`;
  const props: string[] = [];
  node.forEachReference(edge => {
    if (edge.type === 'property') {
      props.push(String(edge.name_or_index));
      if (props.length >= SHAPE_PROP_CAP) return {stop: true};
    }
  });
  props.sort();
  return `${node.name} {${props.join(',')}}`;
}

function trendOf(counts: number[]): string {
  let up = true;
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] <= counts[i - 1]) up = false;
  }
  const net = counts[counts.length - 1] - counts[0];
  if (up && net > 0) return '↑ every step';
  if (net > 0) return 'grew net';
  if (net < 0) return 'shrank';
  return 'flat';
}

export function registerHypothesis(server: McpServer): void {
  server.tool(
    'memlab_hypothesis',
    'Test one hypothesis against EVERY rung of a snapshot ladder in a single call: supply a JavaScript predicate over heap nodes and get its match count, total self size, and trend per rung. ' +
      'This is the "is my theory true across the whole ladder?" tool. Without it, confirming a specific theory — "the growth is Maps with a `_pending` field", "it is closures capturing `chatId`" — meant loading each rung separately and re-running a query by hand, at minutes per rung, which is why theories tended to be checked against one snapshot and generalized. ' +
      'Set group_by_shape to break matches down by property shape per rung instead of a single count, which answers "WHICH variant of this class is the one accumulating?" — the shape sweep that otherwise required a separate pass. Snapshots are loaded one at a time and released, so a long ladder is memory-safe.',
    {
      paths: z
        .array(z.string())
        .min(1)
        .describe(
          'Ordered snapshot paths (oldest first). Local paths, manifold:// URLs, bare filenames, or a single ["ladder:<name>"] reference to a ladder saved with memlab_ladder.',
        ),
      predicates: z
        .array(
          z.object({
            label: z.string().describe('Short name for this hypothesis.'),
            predicate: z
              .string()
              .describe('The expression, as for `predicate`.'),
          }),
        )
        .optional()
        .describe(
          'Test SEVERAL hypotheses in the same pass. Each rung is loaded and walked ONCE and every predicate is applied to each node, so N theories cost what one costs — the load and the walk are the expensive parts, not the predicate. Use this when a question has several candidate explanations: testing them together also makes their counts directly comparable, which sequential calls do not guarantee if a rung is reloaded in between. Mutually exclusive with `predicate`.',
        ),
      predicate: z
        .string()
        .optional()
        .describe(
          'JavaScript expression over `node` returning a boolean, e.g. `node.name === "Map" && node.retainedSize > 10000`, or `node.type === "closure" && node.name.includes("chat")`. Evaluated in a sandbox with no I/O; only the node is exposed. Compiled once and applied per node, so keep it cheap — avoid walking `node.references` for every node in a multi-million-node heap.',
        ),
      group_by_shape: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Break matches down by property-shape fingerprint per rung (default false: one count per rung). Use to find which variant of a class is accumulating.',
        ),
      limit: z
        .number()
        .optional()
        .default(15)
        .describe('Maximum shape rows to report when group_by_shape is set.'),
      max_file_size_mb: z
        .number()
        .optional()
        .describe('Per-file size ceiling in MB; see memlab_load_snapshot.'),
    },
    async ({
      paths,
      predicate,
      predicates,
      group_by_shape,
      limit,
      max_file_size_mb,
    }) => {
      try {
        const batch = predicates != null && predicates.length > 0;
        if (batch && predicate != null) {
          return errorResult(
            'Pass `predicate` OR `predicates`, not both — with both there is no single expression the verdict could be about.',
          );
        }
        if (!batch && (predicate == null || predicate === '')) {
          return errorResult(
            'Pass `predicate` (one hypothesis) or `predicates` (several tested in the same pass).',
          );
        }
        const specs = batch
          ? (predicates ?? [])
          : [{label: predicate as string, predicate: predicate as string}];

        const tests: Array<(node: IHeapNode) => boolean> = [];
        for (const spec of specs) {
          try {
            // Compiled ONCE, in a context with nothing in it: the predicate gets
            // the node it is called with and no ambient capability.
            tests.push(
              vm.runInNewContext(
                `(function(node){ return !!(${spec.predicate}); })`,
                Object.create(null),
                {timeout: 1000},
              ) as (node: IHeapNode) => boolean,
            );
          } catch (e) {
            return errorResult(
              `Could not compile predicate${batch ? ` "${spec.label}"` : ''}: ${e instanceof Error ? e.message : String(e)}. It must be a JavaScript EXPRESSION over \`node\` (no statements, no return).`,
            );
          }
        }

        // Per rung, per predicate. One walk feeds all of them.
        const rungs: Array<{
          label: string;
          scanned: number;
          matched: number[];
          selfBytes: number[];
          shapes: Array<Map<string, number>>;
        }> = [];

        const {paths: rungPaths} = resolveLadderPaths(paths);
        for (const p of rungPaths) {
          const {localPath, fetchedFrom} = resolveSnapshotPath(p);
          if (!fs.existsSync(localPath)) {
            return errorResult(`File not found: ${localPath}`);
          }
          const sizeMB = fs.statSync(localPath).size / (1024 * 1024);
          if (max_file_size_mb != null && sizeMB > max_file_size_mb) {
            return errorResult(
              `${p} is ${sizeMB.toFixed(0)} MB, over the ${max_file_size_mb} MB limit.`,
            );
          }
          const snapshot = await getFullHeapFromFile(localPath);
          const matched = specs.map(() => 0);
          const selfBytes = specs.map(() => 0);
          let scanned = 0;
          let predicateError: string | null = null;
          let failingLabel = '';
          // memlab's nodes.forEach has no early exit, so a predicate that throws
          // on the first node would otherwise still walk every remaining node in
          // a multi-million-node heap before the error is reported. Throwing a
          // sentinel out of the callback actually stops the walk.
          class AbortWalk extends Error {}
          const shapes = specs.map(() => new Map<string, number>());
          try {
            snapshot.nodes.forEach(node => {
              scanned++;
              for (let t = 0; t < tests.length; t++) {
                let hit = false;
                try {
                  hit = tests[t](node);
                } catch (e) {
                  // Report the predicate's own failure rather than a silent
                  // zero: a predicate that throws on the first node would
                  // otherwise look exactly like a hypothesis that is false.
                  predicateError = e instanceof Error ? e.message : String(e);
                  failingLabel = specs[t].label;
                  throw new AbortWalk();
                }
                if (!hit) continue;
                matched[t]++;
                selfBytes[t] += node.self_size;
                if (group_by_shape && shapes[t].size < MAX_SHAPES) {
                  const k = shapeKey(node);
                  shapes[t].set(k, (shapes[t].get(k) ?? 0) + 1);
                }
              }
            });
          } catch (e) {
            if (!(e instanceof AbortWalk)) throw e;
          }
          if (predicateError != null) {
            return errorResult(
              `Predicate${batch ? ` "${failingLabel}"` : ''} threw while scanning ${p}: ${predicateError}. Guard against missing fields — it is applied to every node in the heap, not just the ones you have in mind.`,
            );
          }
          rungs.push({
            label: fetchedFrom ?? p.replace(/^.*\//, ''),
            matched,
            selfBytes,
            scanned,
            shapes,
          });
        }

        const lines: string[] = [];

        if (batch) {
          // One row per hypothesis, so the candidate explanations are compared
          // side by side rather than across separate calls whose rungs may not
          // have been the same load.
          lines.push(
            `## ${specs.length} hypotheses across ${rungs.length} snapshot(s)`,
            '',
            markdownTable(
              [
                'Hypothesis',
                ...rungs.map((r, i) => `#${i + 1}`),
                ...(rungs.length > 1 ? ['Δ', 'Trend'] : []),
              ],
              specs.map((spec, t) => {
                const per = rungs.map(r => r.matched[t]);
                const net = per[per.length - 1] - per[0];
                return [
                  spec.label.length > 40
                    ? spec.label.slice(0, 37) + '…'
                    : spec.label,
                  ...per.map(c => formatNumber(c)),
                  ...(rungs.length > 1
                    ? [
                        `${net >= 0 ? '+' : '−'}${formatNumber(Math.abs(net))}`,
                        trendOf(per),
                      ]
                    : []),
                ];
              }),
              new Set(rungs.map((_, i) => i + 1).concat([rungs.length + 1])),
            ),
            '',
            `_All ${specs.length} predicates were applied in the SAME walk of each rung, so the counts are of one heap state and are directly comparable. Rungs: ${rungs.map(r => r.label).join(' → ')}._`,
          );
          const allZero = specs.every((_, t) =>
            rungs.every(r => r.matched[t] === 0),
          );
          if (allZero) {
            lines.push(
              '',
              '_Every hypothesis matched zero nodes in every rung. All predicates compiled and ran against every node, so these are real negatives — check the class/property names with `memlab_class_histogram` before concluding the theories are all wrong._',
            );
          }
          if (rungs.length === 2) {
            lines.push(
              '',
              '> ⚠️ With 2 rungs "↑ every step" is the same statement as "grew overall" and cannot separate a trend from a single GC-band sample. Add a third rung.',
            );
          }
        } else {
          const counts = rungs.map(r => r.matched[0]);
          const net = counts[counts.length - 1] - counts[0];
          lines.push(
            `## Hypothesis across ${rungs.length} snapshot(s)`,
            '',
            `\`${predicate}\``,
            '',
            markdownTable(
              ['#', 'Snapshot', 'Matches', 'Self size', 'Scanned'],
              rungs.map((r, i) => [
                String(i + 1),
                r.label.length > 38 ? '…' + r.label.slice(-37) : r.label,
                formatNumber(r.matched[0]),
                formatBytes(r.selfBytes[0]),
                formatNumber(r.scanned),
              ]),
              new Set([2, 3, 4]),
            ),
            '',
          );

          if (rungs.length > 1) {
            lines.push(
              `**Verdict: ${trendOf(counts)}** — ${net >= 0 ? '+' : '−'}${formatNumber(Math.abs(net))} matches across the ladder (${formatNumber(counts[0])} → ${formatNumber(counts[counts.length - 1])}).`,
            );
            if (rungs.length === 2) {
              lines.push(
                '',
                '> ⚠️ With 2 rungs "↑ every step" is the same statement as "grew overall" and cannot separate a trend from a single GC-band sample. Add a third rung.',
              );
            }
          } else {
            lines.push(
              '_Single snapshot: this is a count, not a trend. Pass an ordered ladder to test whether the hypothesis holds over time._',
            );
          }

          if (counts.every(c => c === 0)) {
            lines.push(
              '',
              '_Zero matches in every rung. The predicate compiled and ran against every node, so this is a real negative — the hypothesis is false as written, or the property/class is named differently than assumed (check with `memlab_class_histogram`)._',
            );
          }
        }

        if (group_by_shape) {
          const allShapes = new Set<string>();
          for (const r of rungs)
            for (const m of r.shapes)
              for (const k of m.keys()) allShapes.add(k);
          const shapeRows = [...allShapes]
            .map(k => ({
              shape: k,
              // Summed across predicates in batch mode: a shape breakdown per
              // hypothesis would be a table per hypothesis, which is not what
              // this flag is for.
              per: rungs.map(r =>
                r.shapes.reduce((a, m) => a + (m.get(k) ?? 0), 0),
              ),
            }))
            .map(x => ({
              ...x,
              net: x.per[x.per.length - 1] - x.per[0],
            }))
            .sort(
              (a, b) =>
                b.net - a.net ||
                b.per[b.per.length - 1] - a.per[a.per.length - 1],
            )
            .slice(0, limit);
          if (shapeRows.length > 0) {
            lines.push(
              '',
              '### Matches by shape',
              '',
              markdownTable(
                [
                  'Shape',
                  ...rungs.map((_, i) => `#${i + 1}`),
                  'Δ',
                  ...(rungs.length > 1 ? ['Trend'] : []),
                ],
                shapeRows.map(r => [
                  r.shape.length > 56 ? r.shape.slice(0, 53) + '…}' : r.shape,
                  ...r.per.map(c => formatNumber(c)),
                  `${r.net >= 0 ? '+' : '−'}${formatNumber(Math.abs(r.net))}`,
                  ...(rungs.length > 1 ? [trendOf(r.per)] : []),
                ]),
                new Set(rungs.map((_, i) => i + 1).concat([rungs.length + 1])),
              ),
            );
            if (rungs.some(r => r.shapes.some(m => m.size >= MAX_SHAPES))) {
              lines.push(
                '',
                `_⚠ Shape tracking capped at ${formatNumber(MAX_SHAPES)} distinct shapes per rung; the tail is not counted. Narrow the predicate._`,
              );
            }
          }
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
