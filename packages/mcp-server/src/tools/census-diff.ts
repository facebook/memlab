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
import {
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
  withSnapshotAt,
} from '../snapshot-borrow.js';
import {
  abbreviateBlinkTypeName,
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';
import {
  extractElementTag,
  isDetachedDOMNode,
  isPinned,
} from './detached-dom.js';

/**
 * A census is a per-CLASS population at one point in the ladder; a census DIFF
 * is the same census taken at two points and compared row by row.
 *
 * This exists because the diff, not the totals, is the evidence. Two totals that
 * match ("777 detached at both ends") are consistent with a leak that swapped
 * one population for another of equal size, which is a real and observed shape.
 * The per-class rows are what turn "no leak" from a guess into a finding — and
 * the negative result is the common case, so the cheap version of it has to be
 * one call rather than a hand-written thirty-line eval per round.
 */

const CALLBACK_PROPS = new Set(['callback', 'fn', 'handler', 'listener']);
const CONTEXT_PROPS = new Set(['context', 'ctx', 'this', 'target']);

export type CensusKind = 'detached' | 'listeners';

export interface Census {
  /** class / callback name -> count */
  counts: Map<string, number>;
  total: number;
}

function emptyCensus(): Census {
  return {counts: new Map(), total: 0};
}

function bump(census: Census, key: string): void {
  census.counts.set(key, (census.counts.get(key) ?? 0) + 1);
  census.total += 1;
}

/**
 * Detached DOM, bucketed by element tag.
 *
 * Only PINNED nodes are counted, matching `memlab_detached_dom`. Detached nodes
 * with no retainer path are GC-eligible rather than leaked, and their count
 * swings with whatever the collector happened to have done before the capture —
 * including them makes every diff look noisy and hides the rows that moved.
 */
export function censusDetached(snapshot: IHeapSnapshot): Census {
  const census = emptyCensus();
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (!isDetachedDOMNode(node) || !isPinned(node)) return;
    bump(census, extractElementTag(node.name));
  });
  return census;
}

/**
 * Listener records — objects carrying both a callback-ish and a context-ish
 * property — bucketed by callback function name.
 *
 * Bucketing by CALLBACK rather than by host is deliberate. A listener leak shows
 * up as the same handler registered N times; the host is usually a single
 * long-lived emitter whose count never moves, so a host-keyed census reports
 * "1 → 1" for exactly the leak it was run to find.
 */
export function censusListeners(snapshot: IHeapSnapshot): Census {
  const census = emptyCensus();
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.type !== 'object' || node.id <= 3) return;
    let callbackName: string | null = null;
    let hasContext = false;
    for (const edge of node.references) {
      const name = String(edge.name_or_index);
      if (CALLBACK_PROPS.has(name) && edge.toNode.type === 'closure') {
        callbackName =
          edge.toNode.name.length > 0 ? edge.toNode.name : '(anonymous)';
      } else if (CONTEXT_PROPS.has(name)) {
        hasContext = true;
      }
    }
    if (callbackName != null && hasContext) {
      bump(census, callbackName);
    }
  });
  return census;
}

const MAX_KEY_LEN = 60;

/**
 * Keep a census row readable without losing which row it is.
 *
 * Blink's C++ template names (`blink::BasicHeapVector<...>`) run to hundreds of
 * characters and a table of them costs more tokens than the counts it exists to
 * show — one census eval blew the result cap on exactly this. Elide the type
 * arguments first, since the head of the name is the identifying part, and only
 * hard-truncate if it is still too long.
 */
export function clampKey(key: string): string {
  const abbreviated = abbreviateBlinkTypeName(key);
  return abbreviated.length > MAX_KEY_LEN
    ? `${abbreviated.slice(0, MAX_KEY_LEN - 1)}\u2026`
    : abbreviated;
}

export interface DiffRow {
  key: string;
  baseline: number;
  target: number;
  delta: number;
}

export function diffCensus(baseline: Census, target: Census): DiffRow[] {
  const keys = new Set([...baseline.counts.keys(), ...target.counts.keys()]);
  const rows: DiffRow[] = [];
  for (const key of keys) {
    const b = baseline.counts.get(key) ?? 0;
    const t = target.counts.get(key) ?? 0;
    rows.push({key, baseline: b, target: t, delta: t - b});
  }
  // Largest movers first in both directions: a class that SHRANK by 200 is as
  // informative as one that grew by 200, and sorting on the signed delta would
  // bury it at the bottom.
  rows.sort(
    (a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.target - a.target,
  );
  return rows;
}

function renderKind(
  kind: CensusKind,
  baseline: Census,
  target: Census,
  topN: number,
): string[] {
  const rows = diffCensus(baseline, target);
  const moved = rows.filter(r => r.delta !== 0);
  const label =
    kind === 'detached' ? 'Detached DOM (pinned)' : 'Listener records';
  const keyHeader = kind === 'detached' ? 'Element' : 'Callback';

  const lines: string[] = [];
  lines.push(`### ${label}`);
  lines.push('');
  lines.push(
    `Totals: **${formatNumber(baseline.total)} → ${formatNumber(target.total)}** ` +
      `(Δ ${target.total - baseline.total >= 0 ? '+' : ''}${formatNumber(target.total - baseline.total)}) ` +
      `across ${formatNumber(rows.length)} distinct ${kind === 'detached' ? 'element type(s)' : 'callback(s)'}.`,
  );
  lines.push('');

  if (moved.length === 0) {
    lines.push(
      `**IDENTICAL** — every one of the ${formatNumber(rows.length)} rows is unchanged. ` +
        'This is the strong form of a negative result: not merely equal totals, but no ' +
        'population swapped for another of the same size.',
    );
    return lines;
  }

  lines.push(
    markdownTable(
      [keyHeader, 'Baseline', 'Target', 'Δ'],
      moved
        .slice(0, topN)
        .map(r => [
          clampKey(r.key),
          formatNumber(r.baseline),
          formatNumber(r.target),
          `${r.delta >= 0 ? '+' : ''}${formatNumber(r.delta)}`,
        ]),
      new Set([1, 2, 3]),
    ),
  );
  if (moved.length > topN) {
    lines.push('');
    lines.push(
      `_… ${formatNumber(moved.length - topN)} further changed row(s) omitted; raise \`top_n\` to see them._`,
    );
  }
  lines.push('');
  lines.push(
    `${formatNumber(moved.length)} of ${formatNumber(rows.length)} rows changed; ` +
      `${formatNumber(rows.length - moved.length)} identical.`,
  );
  return lines;
}

export function registerCensusDiff(server: McpServer): void {
  server.tool(
    'memlab_census_diff',
    'Take the detached-DOM and listener-record census at TWO rungs and diff them per class / per callback in one call. ' +
      'This is the mandated baseline-vs-final comparison: run the census on BOTH ends and compare the per-class distribution, not just the two totals.\n\n' +
      'Two totals that match are NOT a negative result — they are also consistent with one population being swapped for another of the same size, which is a real observed shape. ' +
      'The per-row diff is what makes the negative claim: "777 nodes across 66 classes, zero change on every one" is a finding; "777 at both ends" is a guess.\n\n' +
      'Replaces the ~30-line eval that otherwise gets rewritten every round (build {class -> count} on each rung, diff the maps by hand), and loads one graph at a time so it works on a ladder of 250-540 MB captures.',
    {
      baseline: z
        .string()
        .describe(
          'Path to the EARLY rung. Local path, manifold:// URL, or bare filename.',
        ),
      target: z
        .string()
        .describe('Path to the LATE rung, compared against the baseline.'),
      kinds: z
        .array(z.enum(['detached', 'listeners']))
        .optional()
        .default(['detached', 'listeners'])
        .describe(
          'Which censuses to take. Both by default, which is what the protocol asks for.',
        ),
      top_n: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(25)
        .describe(
          'Maximum CHANGED rows to print per kind. Unchanged rows are counted, never listed.',
        ),
      max_file_size_mb: z
        .number()
        .optional()
        .describe('Per-file size ceiling, matching memlab_load_snapshot.'),
    },
    async ({baseline, target, kinds, top_n, max_file_size_mb}) => {
      try {
        const {rungs, largestMB} = resolveRungs(
          [baseline, target],
          max_file_size_mb,
        );
        const [baseRung, targetRung] = rungs;
        // Both censuses are full-heap walks, so they run against the same 90s
        // scan guardrail every other tool does. Scale it from the largest
        // capture or a big ladder loses a rung to the guardrail rather than to
        // anything about the heap.
        const scanBudgetMs = scaledTimeoutMs(largestMB);

        const take = (snapshot: IHeapSnapshot): Record<CensusKind, Census> => {
          const out: Record<CensusKind, Census> = {
            detached: emptyCensus(),
            listeners: emptyCensus(),
          };
          // One pass per kind, but only for the kinds asked for: the listener
          // walk visits every object's edges and is the expensive half.
          if (kinds.includes('detached'))
            out.detached = censusDetached(snapshot);
          if (kinds.includes('listeners'))
            out.listeners = censusListeners(snapshot);
          return out;
        };

        armScanBudgetFor(scanBudgetMs);
        const baseCensus = await withSnapshotAt(baseRung.localPath, take);
        armScanBudgetFor(scanBudgetMs);
        const targetCensus = await withSnapshotAt(targetRung.localPath, take);

        const lines: string[] = [];
        lines.push('## Census diff');
        lines.push('');
        lines.push(`- baseline: \`${baseRung.label}\``);
        lines.push(`- target: \`${targetRung.label}\``);
        lines.push('');

        let anyMoved = false;
        for (const kind of kinds) {
          const rows = diffCensus(baseCensus[kind], targetCensus[kind]);
          if (rows.some(r => r.delta !== 0)) anyMoved = true;
          lines.push(
            ...renderKind(kind, baseCensus[kind], targetCensus[kind], top_n),
          );
          lines.push('');
        }

        lines.push(
          anyMoved
            ? '_A changed row is a population, not yet a leak. Trace a sample with `memlab_retainer_trace` and check ' +
                '`memlab_dev_artifacts` before attributing it — React DEV and Fast Refresh populations grow across a ladder too._'
            : '_Nothing moved in either census. Record this: an unchanged per-class distribution across the ladder is the ' +
                'strongest cheap evidence that a suspected leak is not in the DOM or listener population at all._',
        );

        return toolResult(lines.join('\n'));
      } catch (e) {
        return errorResult(e instanceof Error ? e : new Error(String(e)));
      }
    },
  );
}
