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
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  resolveRungs,
  withSnapshotAt,
  armScanBudgetFor,
  scaledTimeoutMs,
} from '../snapshot-borrow.js';
import {resolveLadderInputs, SEGMENT_ARG_DESCRIPTION} from '../run-manifest.js';
import {
  nearestFiber,
  fiberComponentName,
  isUpdateRecord,
} from '../react-shapes.js';
import {
  errorResult,
  toolResult,
  formatNumber,
  markdownTable,
  suggestionsSuppressed,
} from '../utils.js';

interface QueueReport {
  queueId: number;
  component: string;
  length: number;
  terminated: 'cycle' | 'end' | 'cap';
}

/**
 * Length of a `queue.pending` chain.
 *
 * React's update queue is CIRCULAR, which is the detail that makes a
 * hand-written walk report its own hop cap as a measurement: a
 * `while (next && next.id !== start)` guarded by `hops < 800` returned 800 for
 * a chain of 2,066, and nothing in the output distinguished the two. The
 * terminator is returned so a capped walk can never be quoted as a length.
 */
function chainLength(
  head: IHeapNode,
  maxHops: number,
): {length: number; terminated: 'cycle' | 'end' | 'cap'} {
  const seen = new Set<number>();
  let cur: IHeapNode | null = head;
  while (cur != null) {
    if (seen.has(cur.id)) return {length: seen.size, terminated: 'cycle'};
    if (seen.size >= maxHops) return {length: seen.size, terminated: 'cap'};
    seen.add(cur.id);
    let next: IHeapNode | null = null;
    for (const edge of cur.references) {
      if (String(edge.name_or_index) !== 'next') continue;
      next = edge.toNode.id > 3 ? edge.toNode : null;
      break;
    }
    cur = next;
  }
  return {length: seen.size, terminated: 'end'};
}

interface Bucket {
  component: string;
  queues: number;
  records: number;
  longest: number;
  capped: number;
  example: number;
}

interface ScanResult {
  reports: QueueReport[];
  totalRecords: number;
  ranked: Bucket[];
  pendingRecords: number;
}

/**
 * The whole per-snapshot measurement, factored out so a ladder can run it on
 * every rung.
 *
 * It was inline in the handler, which made this a single-snapshot tool — and
 * the breadth-vs-length split it exists to report is only meaningful ACROSS
 * rungs. Every round therefore called it once per rung and diffed the tables by
 * hand, which is where the finding actually came from: three hand-copied rows
 * showing one component at exactly +1.000 records/cycle while breadth stayed
 * flat.
 */
function scanUpdateQueues(
  snapshot: IHeapSnapshot,
  maxChain: number,
  maxHops: number,
): ScanResult {
  // A queue is recognised by holding a `pending` edge to an update
  // record, rather than by name: `queue` is minified and the hook object
  // it hangs off is a plain Object.
  const queues: IHeapNode[] = [];
  let totalRecords = 0;
  snapshot.nodes.forEach(node => {
    if (node.type !== 'object') return;
    if (isUpdateRecord(node)) totalRecords++;
    for (const edge of node.references) {
      if (edge.type !== 'property') continue;
      if (String(edge.name_or_index) !== 'pending') continue;
      if (isUpdateRecord(edge.toNode)) queues.push(node);
      break;
    }
  });

  const reports: QueueReport[] = [];
  for (const queue of queues) {
    let head: IHeapNode | null = null;
    for (const edge of queue.references) {
      if (String(edge.name_or_index) === 'pending') {
        head = edge.toNode;
        break;
      }
    }
    if (head == null) continue;
    const {length, terminated} = chainLength(head, maxChain);
    const fiber = nearestFiber(queue, maxHops);
    reports.push({
      queueId: queue.id,
      component:
        (fiber != null ? fiberComponentName(fiber) : null) ?? '(unattributed)',
      length,
      terminated,
    });
  }

  const byComponent = new Map<string, Bucket>();
  for (const r of reports) {
    let b = byComponent.get(r.component);
    if (!b) {
      b = {
        component: r.component,
        queues: 0,
        records: 0,
        longest: 0,
        capped: 0,
        example: r.queueId,
      };
      byComponent.set(r.component, b);
    }
    b.queues++;
    b.records += r.length;
    if (r.length > b.longest) {
      b.longest = r.length;
      b.example = r.queueId;
    }
    if (r.terminated === 'cap') b.capped++;
  }

  const ranked = [...byComponent.values()].sort(
    (a, b) => b.records - a.records,
  );
  return {
    reports,
    totalRecords,
    ranked,
    pendingRecords: reports.reduce((s, r) => s + r.length, 0),
  };
}

/**
 * Breadth and length across a whole ladder, in one call.
 *
 * The two numbers have to be read SEPARATELY and against the same cycle axis:
 * flat breadth with rising records is accumulation inside existing queues (the
 * leak), while rising breadth at ~1 record each is just more hooks mounted.
 * Reporting them together, per component, is what turns this from a census into
 * a verdict.
 */
async function ladderReport(args: {
  paths?: string[];
  run_dir?: string;
  segment?: number | 'all';
  max_chain: number;
  max_hops: number;
  limit: number;
}): Promise<ReturnType<typeof toolResult>> {
  const inputs = resolveLadderInputs({
    run_dir: args.run_dir,
    paths: args.paths,
    segment: args.segment,
  });
  if (inputs.paths.length < 2) {
    return errorResult(
      new Error(
        'A ladder needs at least 2 rungs; with one, "grew at every step" and "grew overall" are the same statement.',
      ),
    );
  }
  const {rungs, largestMB} = resolveRungs(inputs.paths);
  armScanBudgetFor(scaledTimeoutMs(largestMB));

  const perRung: ScanResult[] = [];
  for (const rung of rungs) {
    armScanBudgetFor(scaledTimeoutMs(largestMB));
    const res = await withSnapshotAt(rung.localPath, snap =>
      scanUpdateQueues(snap, args.max_chain, args.max_hops),
    );
    perRung.push(res);
  }

  const axis = inputs.cyclesPerRung;
  const cycleSpan =
    axis != null && axis.length === perRung.length
      ? axis[axis.length - 1] - axis[0]
      : null;
  const rate = (first: number, last: number): string =>
    cycleSpan != null && cycleSpan > 0
      ? ((last - first) / cycleSpan).toFixed(3)
      : '—';

  const lines: string[] = [
    '## React update queues across the ladder',
    '',
    `_${rungs.length} rungs${axis != null ? `, cycle axis [${axis.join(', ')}]${inputs.source === 'assumed-even' ? ' (ASSUMED even — pass `run_dir` for the measured axis)' : ' (measured)'}` : ', no cycle axis — pass `run_dir` for per-cycle rates'}._`,
    '',
  ];

  const breadth = perRung.map(r => r.reports.length);
  const records = perRung.map(r => r.pendingRecords);
  lines.push(
    markdownTable(
      ['Rung', ...rungs.map(r => r.label.replace(/^.*\//, ''))],
      [
        ['Breadth (queues)', ...breadth.map(v => formatNumber(v))],
        ['Length (pending records)', ...records.map(v => formatNumber(v))],
      ],
      new Set(rungs.map((_, i) => i + 1)),
    ),
    '',
    `**Breadth ${breadth[0]} → ${breadth[breadth.length - 1]}** (${rate(breadth[0], breadth[breadth.length - 1])}/cycle) · ` +
      `**Records ${formatNumber(records[0])} → ${formatNumber(records[records.length - 1])}** (${rate(records[0], records[records.length - 1])}/cycle)`,
    '',
  );

  // The discriminator is whether breadth ROSE, not whether it was constant.
  // A ladder that ends with FEWER queues than it started (components unmounted)
  // while records climb is the accumulation shape just as much as a flat one is
  // — arguably more so. Testing `every(v => v === breadth[0])` called
  // 64/64/64/63 "both rising" and pointed the reader at the wrong conclusion.
  const first = records[0];
  const last = records[records.length - 1];
  const breadthDelta = breadth[breadth.length - 1] - breadth[0];
  const breadthRose = breadthDelta > 0;
  const recordsRising = last > first;
  const perQueueFirst = breadth[0] > 0 ? first / breadth[0] : 0;
  const perQueueLast =
    breadth[breadth.length - 1] > 0 ? last / breadth[breadth.length - 1] : 0;
  lines.push(
    !breadthRose && recordsRising
      ? `**Verdict: breadth did NOT rise (${breadth[0]} → ${breadth[breadth.length - 1]}) while records climbed — accumulation inside existing queues. This is the leak shape, and it is what to file.**`
      : breadthRose && recordsRising
        ? `**Verdict: BOTH rose** (queues +${formatNumber(breadthDelta)}, records +${formatNumber(last - first)}). Separate them before concluding, or the write-up will attribute mounting to leaking: records per queue went ${perQueueFirst.toFixed(1)} → ${perQueueLast.toFixed(1)}${perQueueLast > perQueueFirst * 1.5 ? ', which is still accumulation on top of the mounting' : ', consistent with mounting alone'}.`
        : '**Verdict: records did not rise across the ladder.**',
    '',
  );

  // Per component, first vs last rung — the row that names the owner.
  const names = new Set<string>();
  for (const r of perRung) for (const b of r.ranked) names.add(b.component);
  const firstOf = (rungIdx: number, name: string): Bucket | undefined =>
    perRung[rungIdx].ranked.find(b => b.component === name);
  const rows = [...names]
    .map(name => {
      const a = firstOf(0, name);
      const z = firstOf(perRung.length - 1, name);
      return {
        name,
        q0: a?.queues ?? 0,
        q1: z?.queues ?? 0,
        r0: a?.records ?? 0,
        r1: z?.records ?? 0,
        longest: z?.longest ?? 0,
      };
    })
    .sort((x, y) => y.r1 - y.r0 - (x.r1 - x.r0));

  lines.push(
    markdownTable(
      [
        'Component',
        'Queues (first → last)',
        'Records (first → last)',
        'Δ records',
        'Δ/cycle',
        'Longest chain',
      ],
      rows
        .slice(0, args.limit)
        .map(r => [
          r.name,
          `${formatNumber(r.q0)} → ${formatNumber(r.q1)}`,
          `${formatNumber(r.r0)} → ${formatNumber(r.r1)}`,
          formatNumber(r.r1 - r.r0),
          rate(r.r0, r.r1),
          formatNumber(r.longest),
        ]),
      new Set([3, 4, 5]),
    ),
    '',
    '_A component whose QUEUES stay flat while its RECORDS climb is lengthening one chain — the eager-bailout shape. One whose queues climb in step with its records is just mounting more hooks._',
  );

  if (!suggestionsSuppressed('memlab_react_update_queues')) {
    lines.push(
      '',
      '**Suggested next steps**',
      '- `memlab_replicate` before filing: this family has produced a retraction when a single run was trusted.',
      '- `memlab_verify_fix({metric_kind: "pending_chain", locator: "<Owner>.<property>"})` once both arms are driven.',
    );
  }
  return toolResult(lines.join('\n'));
}

export function registerReactUpdateQueues(server: McpServer): void {
  server.tool(
    'memlab_react_update_queues',
    'The React eager-bailout leak family as one report. A `useState` update whose eager comparison bails out still leaves its record on `queue.pending`, which then never drains — four separate findings in this workstream have been that same shape, and each round re-derived the same three things by hand. This returns: how many queues hold a pending chain (BREADTH), how long each chain is (LENGTH), and which component owns it. The breadth-vs-length split is the part that decides the finding — a flat queue count with growing records is accumulation in existing queues, which is the leak; a rising queue count with one record each is just more hooks mounted, which is not. Getting that backwards is the difference between a filing and a retraction. Pass `run_dir` (or `paths`) to read a WHOLE LADDER in one call: breadth and length per rung, the per-cycle rate for each component, and the breadth-vs-length verdict — otherwise that comparison has to be assembled by hand from N single-snapshot calls.',
    {
      max_chain: z
        .number()
        .optional()
        .default(100000)
        .describe(
          'Safety bound on links walked per chain (default 100000). A chain longer than this is itself the finding; the result says it was capped rather than reporting the cap as a length.',
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum components to report (default 20).'),
      max_hops: z
        .number()
        .optional()
        .default(12)
        .describe('Referrer hops allowed when looking for the owning fiber.'),
      run_dir: z
        .string()
        .optional()
        .describe(
          "A leak-hunt round's output directory (the one holding run.json and snapshots/). Reads the whole ladder and reports BREADTH and LENGTH per rung, plus each component's per-cycle rate — which is the comparison this tool's own guidance asks for and which otherwise has to be done by hand across N single-snapshot calls.",
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Ordered snapshot paths (oldest first), as an alternative to `run_dir`. Ignored when `run_dir` is given.',
        ),
      segment: z
        .union([z.number().int().min(0), z.literal('all')])
        .optional()
        .describe(SEGMENT_ARG_DESCRIPTION),
    },
    async ({max_chain, limit, max_hops, paths, run_dir, segment}) => {
      try {
        // Ladder mode: the breadth-vs-length split this tool exists to report
        // is only decidable across rungs, so it can now read a whole run.
        if (
          (paths != null && paths.length > 0) ||
          (run_dir != null && run_dir !== '')
        ) {
          return await ladderReport({
            paths,
            run_dir,
            segment,
            max_chain,
            max_hops,
            limit,
          });
        }

        const snapshot = getSnapshot();
        const {reports, totalRecords, ranked, pendingRecords} =
          scanUpdateQueues(snapshot, max_chain, max_hops);

        if (reports.length === 0) {
          return toolResult(
            'No React update queue in this snapshot holds a pending chain.\n\n' +
              `${formatNumber(totalRecords)} update record(s) exist in total. If that number is large while no queue holds one, the records are retained by something OTHER than a live queue — which is a different (and usually more interesting) finding: trace one with \`memlab_retainer_trace\`.`,
          );
        }

        const shown = ranked.slice(0, limit);
        const anyCapped = reports.some(r => r.terminated === 'cap');

        const lines: string[] = [
          '## React update queues holding a pending chain',
          '',
          `**Breadth: ${formatNumber(reports.length)} queue(s)** · **Length: ${formatNumber(pendingRecords)} pending record(s)** · ` +
            `${formatNumber(totalRecords)} update record(s) exist in the heap in total.`,
          '',
          markdownTable(
            [
              'Component',
              'Queues',
              'Pending records',
              'Longest chain',
              'Example',
            ],
            shown.map(b => [
              b.component + (b.capped > 0 ? ' ⚠' : ''),
              formatNumber(b.queues),
              formatNumber(b.records),
              formatNumber(b.longest),
              `@${b.example}`,
            ]),
            new Set([1, 2, 3]),
          ),
          '',
        ];
        if (ranked.length > shown.length) {
          lines.push(
            `_${formatNumber(ranked.length - shown.length)} further component(s) not shown; raise \`limit\`._`,
            '',
          );
        }
        if (anyCapped) {
          lines.push(
            `⚠ ${formatNumber(reports.filter(r => r.terminated === 'cap').length)} chain(s) hit the ${formatNumber(max_chain)}-link cap — those lengths are FLOORS, not measurements. Raise \`max_chain\`.`,
            '',
          );
        }

        lines.push(
          '### How to read this across a ladder',
          '',
          '- **Queue count (breadth) FLAT, pending records rising** → existing queues are accumulating. This is the leak shape, and it is what to file.',
          '- **Queue count rising, records-per-queue ~1** → more components are mounted. Not a leak; the population scales with the UI.',
          '- **Both rising** → separate them before concluding, or the write-up will attribute mounting to leaking.',
          '',
          'One measured round found `REPRODUCED` on record count and `NOT_REPRODUCED` on breadth across independent runs, which is exactly what proved the chains were lengthening rather than multiplying.',
        );

        if (
          !suggestionsSuppressed('memlab_react_update_queues') &&
          shown.length > 0
        ) {
          lines.push(
            '',
            '**Suggested next steps**',
            `- \`memlab_ladder_probe\` on this tool's two numbers across the rungs — breadth and total pending records, separately.`,
            `- \`memlab_replicate\` before filing: this family has produced a retraction when a single run was trusted.`,
            `- \`memlab_verify_fix({metric_kind: "pending_chain", locator: "<Owner>.<property>"})\` once both arms are driven — no runtime gate needed, it takes two sets of snapshot files.`,
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
