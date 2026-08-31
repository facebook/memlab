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
import fs from 'fs';
import memlabCore from '@memlab/core';
import memlabHeapAnalysis from '@memlab/heap-analysis';
import {z} from 'zod';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  matchesPropertyShape,
  pathsHeader,
  toolResult,
} from '../utils.js';
import {countEntries, parseLocator, resolvePath} from './collection-trend.js';
import {resolveLadderPaths} from './ladder.js';
import {resolveMaxFileSizeMB, resolveSnapshotPath} from './load-snapshot.js';

const {utils: memlabUtils} = memlabCore;
const {getFullHeapFromFile} = memlabHeapAnalysis;

type MetricKind =
  | 'collection_length'
  | 'class_count'
  | 'pending_chain'
  | 'shape_count'
  | 'shape_self_bytes'
  | 'retained_size';

/**
 * `retained_size` is the only metric that needs the dominator pass; every other
 * one is read off names and edges. Kept as a predicate rather than inlined so
 * the light/full decision is made in exactly one place — a light snapshot
 * returns 0 for `retainedSize` WITHOUT failing, which is the silent-zero trap
 * the eval pre-flight already guards against.
 */
function needsRetainedSizes(kind: MetricKind): boolean {
  return kind === 'retained_size';
}

/** `"a, b,c"` -> `Set{a, b, c}`. Empty entries dropped. */
function parseShapeLocator(locator: string): Set<string> {
  return new Set(
    locator
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  );
}

// Guard against a corrupt or genuinely circular chain. V8's update queues ARE
// circular (`queue.pending.next` loops back), so the walk stops on a repeat as
// well — the cap only catches a chain longer than any real one.
const MAX_CHAIN = 100_000;

/**
 * Measure the metric on one parsed snapshot. One scalar per snapshot is the
 * whole point: the arms are compared on a rate, and a rate needs a number per
 * rung, not a report.
 */
export function measureMetric(
  snapshot: IHeapSnapshot,
  kind: MetricKind,
  locator: string,
  chainEdge: string,
): number {
  if (kind === 'class_count') {
    const want = locator.trim();
    let count = 0;
    snapshot.nodes.forEach(node => {
      if (node.id > 3 && node.name === want) count++;
    });
    return count;
  }

  if (kind === 'shape_count' || kind === 'shape_self_bytes') {
    const required = parseShapeLocator(locator);
    let total = 0;
    snapshot.nodes.forEach(node => {
      if (!matchesPropertyShape(node, required)) return;
      total += kind === 'shape_count' ? 1 : node.self_size;
    });
    return total;
  }

  if (kind === 'retained_size') {
    // The single largest instance, not the sum: the metric the leak-hunt
    // methodology asks you to quote is "the retained size of the object the fix
    // targets", and summing retained sizes over instances that nest on the
    // dominator tree double-counts.
    const want = locator.trim();
    let largest = 0;
    snapshot.nodes.forEach(node => {
      if (node.id <= 3 || node.name !== want) return;
      if (node.retainedSize > largest) largest = node.retainedSize;
    });
    return largest;
  }

  const loc = parseLocator(locator);
  let total = 0;
  snapshot.nodes.forEach(node => {
    if (node.id <= 3 || node.name !== loc.ownerClass) return;
    const target = resolvePath(node, loc.path);
    if (target == null) return;
    if (kind === 'collection_length') {
      total += countEntries(target) ?? 0;
      return;
    }
    // pending_chain: follow the linked list from the head, counting nodes.
    let cur: IHeapNode | null = target;
    const seen = new Set<number>();
    let len = 0;
    while (cur && !seen.has(cur.id) && len < MAX_CHAIN) {
      seen.add(cur.id);
      len++;
      let next: IHeapNode | null = null;
      for (const edge of cur.references) {
        if (edge.type === 'hidden') continue;
        if (String(edge.name_or_index) !== chainEdge) continue;
        next = edge.toNode.id > 3 ? edge.toNode : null;
        break;
      }
      cur = next;
    }
    total += len;
  });
  return total;
}

async function measureArm(
  paths: string[],
  kind: MetricKind,
  locator: string,
  chainEdge: string,
  maxFileSizeMB?: number,
): Promise<{labels: string[]; values: number[]}> {
  const labels: string[] = [];
  const values: number[] = [];
  for (const p of paths) {
    let local: string;
    let fetchedFrom: string | null = null;
    try {
      const r = resolveSnapshotPath(p);
      local = r.localPath;
      fetchedFrom = r.fetchedFrom;
    } catch (e) {
      throw new Error(
        `Failed to resolve "${p}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!fs.existsSync(local)) throw new Error(`File not found: ${local}`);
    const sizeMB = fs.statSync(local).size / (1024 * 1024);
    const limit = resolveMaxFileSizeMB(maxFileSizeMB, fetchedFrom != null);
    if (sizeMB > limit) {
      throw new Error(
        `${p} is ${sizeMB.toFixed(0)} MB — exceeds the ${limit} MB per-file safety limit. Raise it with max_file_size_mb: ${Math.ceil(sizeMB + 100)}.`,
      );
    }
    // Light parse by default: most metrics are read off names and edges, so the
    // dominator/retained-size pass would be paid on every rung of both arms for
    // nothing. `retained_size` is the exception and must have it — on a light
    // snapshot `retainedSize` reads back 0 WITHOUT failing, so a silent zero
    // would be reported as "the fix removed everything", which is the most
    // damaging possible wrong answer from a fix-verification tool.
    const snapshot = needsRetainedSizes(kind)
      ? await getFullHeapFromFile(local)
      : await memlabUtils.getSnapshotFromFile(local, {
          buildNodeIdIndex: true,
          verbose: false,
        });
    labels.push(fetchedFrom ?? p.replace(/^.*\//, ''));
    values.push(measureMetric(snapshot, kind, locator, chainEdge));
  }
  return {labels, values};
}

/** Growth per interaction cycle across an arm's ladder. */
export function perCycleRate(values: number[], cycles: number): number {
  const steps = values.length - 1;
  if (steps <= 0 || cycles <= 0) return 0;
  return (values[values.length - 1] - values[0]) / (steps * cycles);
}

export function registerVerifyFix(server: McpServer): void {
  server.tool(
    'memlab_verify_fix',
    'Decide whether a fix actually worked, by comparing the per-cycle growth RATE of one metric between a before ladder and an after ladder. hunt_runner --ab drives both arms but nothing analyses them, which is why fix write-ups stall at "A/B pending". ' +
      'NO RUNTIME GATE IS REQUIRED: the two arms are two sets of snapshot files passed as `before_paths` and `after_paths`, so a fix that cannot be put behind a flag — a build-only change, a local patch, a reverted commit — is verified exactly the same way. One session concluded this tool was unusable for an ungated fix and skipped A/B entirely; it is not. ' +
      'Metrics: "collection_length" (entries under "<OwnerClass>.<property>"), "class_count" (instances of a class), "pending_chain" (total length of the linked lists hanging off "<OwnerClass>.<property>", following `next` — the React update-queue shape), ' +
      '"shape_count" and "shape_self_bytes" (objects carrying ALL of a comma-separated property set — use these when the leaking population is anonymous object literals, whose class name is the useless "Object"; this is the common case for record types and the reason a session with a real A/B still had to hand-roll the comparison), ' +
      '"retained_size" (retained size of the LARGEST instance of a class — the figure the leak-hunt methodology asks you to quote for a fix, rather than aggregate heap). ' +
      'Note "retained_size" forces a FULL parse of every rung on both arms because retained sizes need the dominator pass; the other metrics load LIGHT. ' +
      'Compares RATES, not levels: a build difference, a warmer cache or a longer session all shift the absolute level, and only the slope per interaction says whether the thing still accumulates. Each arm therefore needs at least 2 rungs — a single snapshot per arm is refused rather than compared, because that comparison is confounded. ' +
      'Returns both series, both rates, the reduction, and a PASS/FAIL against expected_reduction. Loads rungs transiently in LIGHT mode, one graph at a time.',
    {
      metric_kind: z
        .enum([
          'collection_length',
          'class_count',
          'pending_chain',
          'shape_count',
          'shape_self_bytes',
          'retained_size',
        ])
        .describe('What to measure on every rung of both arms.'),
      locator: z
        .string()
        .describe(
          'For collection_length / pending_chain: "<OwnerClass>.<property>" (deeper paths allowed). For class_count and retained_size: the class name alone. For shape_count / shape_self_bytes: a comma-separated property set, e.g. "timeToFirstByte,timeToLastByte,transferSize" — matching is the same as memlab_find_by_shape, so the population counted here is the population that tool finds.',
        ),
      before_paths: z
        .array(z.string())
        .describe(
          'Ordered rungs of the UNFIXED arm, oldest first. A single ["ladder:<name>"] element expands to a saved ladder.',
        ),
      after_paths: z
        .array(z.string())
        .describe('Ordered rungs of the FIXED arm, oldest first.'),
      cycles: z
        .number()
        .describe(
          'Interaction cycles driven between consecutive rungs. Must be the same for both arms — otherwise the rates are not comparable.',
        ),
      expected_reduction: z
        .number()
        .optional()
        .default(0.9)
        .describe(
          'Fraction of the before-rate the fix is expected to remove, 0–1 (default 0.9). A leak fix should drive the rate to ~0; a sizing fix will not.',
        ),
      chain_edge: z
        .string()
        .optional()
        .default('next')
        .describe(
          'Edge name to follow for metric_kind "pending_chain" (default "next").',
        ),
      max_file_size_mb: z
        .number()
        .optional()
        .describe('Per-file size limit override (MB).'),
    },
    async ({
      metric_kind,
      locator,
      before_paths,
      after_paths,
      cycles,
      expected_reduction,
      chain_edge,
      max_file_size_mb,
    }) => {
      try {
        const before = resolveLadderPaths(before_paths).paths;
        const after = resolveLadderPaths(after_paths).paths;
        // Name BOTH arms: this tool never reads the resident snapshot, and a
        // fix-validation result labelled with an unrelated capture is the
        // worst place to leave a reader guessing which build was measured.
        const armsHeader = pathsHeader([
          ...before.map(p => `before:${p.replace(/^.*\//, '')}`),
          ...after.map(p => `after:${p.replace(/^.*\//, '')}`),
        ]);
        for (const [label, arm] of [
          ['before_paths', before],
          ['after_paths', after],
        ] as const) {
          if (arm.length < 2) {
            return errorResult(
              `${label} has ${arm.length} rung(s); each arm needs at least 2. This tool compares per-cycle RATES, and one snapshot gives a level, not a rate — comparing levels across two builds is confounded by warmup, session length and build differences.`,
            );
          }
        }
        if (cycles <= 0) {
          return errorResult('cycles must be greater than 0.');
        }
        if (expected_reduction < 0 || expected_reduction > 1) {
          return errorResult('expected_reduction must be between 0 and 1.');
        }

        const b = await measureArm(
          before,
          metric_kind,
          locator,
          chain_edge,
          max_file_size_mb,
        );
        const a = await measureArm(
          after,
          metric_kind,
          locator,
          chain_edge,
          max_file_size_mb,
        );

        const beforeRate = perCycleRate(b.values, cycles);
        const afterRate = perCycleRate(a.values, cycles);

        // Byte-valued metrics read as nonsense in raw counts — "1162420" is not
        // a number anyone checks, "1.1 MB" is.
        const isBytes =
          metric_kind === 'shape_self_bytes' || metric_kind === 'retained_size';
        const fmtVal = (v: number): string =>
          isBytes ? formatBytes(v) : formatNumber(v);
        const fmtRate = (r: number): string =>
          isBytes
            ? `${formatBytes(Math.round(r))}`
            : Math.abs(r) < 10
              ? r.toFixed(2)
              : formatNumber(Math.round(r));

        const lines: string[] = [
          `## Fix verification — \`${metric_kind}\` on \`${locator}\``,
          '',
          markdownTable(
            ['Arm', 'Rungs', 'First', 'Last', 'Net', 'Per cycle'],
            [
              [
                'before (unfixed)',
                String(b.values.length),
                fmtVal(b.values[0]),
                fmtVal(b.values[b.values.length - 1]),
                fmtVal(b.values[b.values.length - 1] - b.values[0]),
                fmtRate(beforeRate),
              ],
              [
                'after (fixed)',
                String(a.values.length),
                fmtVal(a.values[0]),
                fmtVal(a.values[a.values.length - 1]),
                fmtVal(a.values[a.values.length - 1] - a.values[0]),
                fmtRate(afterRate),
              ],
            ],
            new Set([1, 2, 3, 4, 5]),
          ),
          '',
          `- before series: ${b.values.map(v => fmtVal(v)).join(' → ')}`,
          `- after series: ${a.values.map(v => fmtVal(v)).join(' → ')}`,
          '',
        ];

        if (beforeRate <= 0) {
          lines.push(
            `⚠ **Inconclusive — the BEFORE arm does not grow** (rate ${fmtRate(beforeRate)}/cycle). There is nothing for the fix to reduce, so this run cannot validate it. The unfixed arm has to reproduce the leak first: check the metric and locator, drive more cycles, or confirm the arm really is running the unfixed build.`,
          );
          return toolResult(lines.join('\n'), armsHeader);
        }

        const reduction = (beforeRate - afterRate) / beforeRate;
        const pass = reduction >= expected_reduction;
        lines.push(
          `**Reduction: ${(reduction * 100).toFixed(1)}%** of the before-rate (${fmtRate(beforeRate)} → ${fmtRate(afterRate)} per cycle), against an expected ${(expected_reduction * 100).toFixed(0)}%.`,
          '',
          pass
            ? `✅ **PASS** — the fixed arm accumulates ${(reduction * 100).toFixed(1)}% less per cycle.${afterRate > 0 ? ` It is not zero (${fmtRate(afterRate)}/cycle remains), so state the residual rather than claiming the leak is gone.` : ' The residual rate is zero.'}`
            : `❌ **FAIL** — ${(reduction * 100).toFixed(1)}% is short of the expected ${(expected_reduction * 100).toFixed(0)}%. The fixed arm still accumulates ${fmtRate(afterRate)} per cycle.`,
        );
        lines.push(
          '',
          `_Both arms must have been driven with the same interaction and the same ${formatNumber(cycles)} cycles between rungs; nothing in a .heapsnapshot records that, so it is the caller's to guarantee — record it with \`memlab_ladder\`. Two rungs per arm give a two-point slope: add rungs if the before-arm series is not monotonic, since a single noisy pair can produce either verdict._`,
        );
        return toolResult(lines.join('\n'), armsHeader);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
