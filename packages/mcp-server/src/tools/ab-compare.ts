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
import fs from 'fs';
import path from 'path';
import {z} from 'zod';
import {
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
  withSnapshotAt,
} from '../snapshot-borrow.js';
import {linearFit, probeRung} from './ladder-probe.js';
import {BUILTIN, countOne} from './census.js';
import {
  collectDevRoots,
  computeReachableWithoutDevRoots,
} from './dev-artifacts.js';
import type {IHeapSnapshot} from '@memlab/core';
import {resolveProbeSet} from '../probe-sets.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * One A/B round, judged per metric: the same probes on the OFF arm's rungs
 * and on the ON arm's, each arm fitted against its own cycles.
 *
 * The ladder tools refuse an A/B round as a single ladder (the page reloads
 * between arms, so the series is split), which left every A/B verdict to
 * hand-built per-arm path lists and a hand-made table.
 */

interface Arm {
  name: 'off' | 'on';
  prop: string | null;
  value: unknown;
  paths: string[];
  cycles: number[];
}

function readArms(runDir: string): Arm[] {
  const raw = JSON.parse(
    fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'),
  ) as {
    ab?: Record<
      string,
      {prop?: string; value?: unknown; rungs?: number[]} | undefined
    >;
    rungs?: Array<{index: number; path: string; cycles: number}>;
  };
  const ab = raw.ab;
  if (ab == null || ab.off == null || ab.on == null) {
    throw new Error(
      `${runDir}/run.json has no \`ab\` section — this is not an A/B round (hunt_runner --ab).`,
    );
  }
  const byIndex = new Map((raw.rungs ?? []).map(r => [r.index, r]));
  return (['off', 'on'] as const).map(name => {
    const arm = ab[name] ?? {};
    const rungs = (arm.rungs ?? [])
      .map(i => byIndex.get(i))
      .filter(
        (r): r is {index: number; path: string; cycles: number} => r != null,
      );
    return {
      name,
      prop: arm.prop ?? null,
      value: arm.value,
      paths: rungs.map(r => r.path),
      cycles: rungs.map(r => r.cycles),
    };
  });
}

type MetricSpec = string | {code: string; cap?: number};

const RAW_TOTAL = 'heap self KB (raw)';
const PROD_TOTAL = 'heap self KB (production-only)';

/**
 * Total self size in KB (MB would sit under the verdict's 0.01/cycle noise
 * floor for any realistic leak), and the part a production build would also hold
 * (null when the snapshot has no dev roots). A dev-only backing store that
 * doubles in one arm moves the raw total by megabytes and the production
 * total not at all.
 */
function heapTotals(snap: IHeapSnapshot): {raw: number; prod: number | null} {
  const devRoots = collectDevRoots(snap);
  const reached =
    devRoots.byId.size > 0
      ? computeReachableWithoutDevRoots(snap, devRoots)
      : null;
  let raw = 0;
  let prod = 0;
  snap.nodes.forEach(node => {
    if (node.id <= 3) return;
    raw += node.self_size;
    if (reached == null || reached[node.nodeIndex] === 1) {
      prod += node.self_size;
    }
  });
  const kb = (b: number) => Math.round(b / 1024);
  return {raw: kb(raw), prod: reached == null ? null : kb(prod)};
}

function rateOf(cycles: number[], ys: Array<number | null>) {
  const pts = cycles
    .map((c, i) => ({x: c - cycles[0], y: ys[i]}))
    .filter((p): p is {x: number; y: number} => p.y != null);
  if (pts.length < 2 || new Set(pts.map(p => p.x)).size < 2) return null;
  return linearFit(
    pts.map(p => p.x),
    pts.map(p => p.y),
  );
}

/**
 * The OFF arm's measured span and starting value, over measured rungs only.
 * The span runs from the lowest to the highest measured cycle count, so equal
 * or out-of-order endpoints cannot zero it; with no positive span there is
 * nothing to judge growth over, and the gate is skipped.
 */
function offGrowth(
  cycles: number[],
  ys: Array<number | null>,
): {span: number; start: number} | undefined {
  const pts = ys
    .map((y, i) => ({x: cycles[i], y}))
    .filter((p): p is {x: number; y: number} => p.y != null);
  if (pts.length === 0) return undefined;
  const lo = pts.reduce((a, b) => (b.x < a.x ? b : a));
  const hi = pts.reduce((a, b) => (b.x > a.x ? b : a));
  const span = hi.x - lo.x;
  return span > 0 ? {span, start: lo.y} : undefined;
}

export function abVerdict(
  off: number | null,
  on: number | null,
  offMax: number | null,
  cap?: number,
  // What the OFF arm grew by over its cycles, against where it started: an
  // arm that barely moves cannot show a fix doing anything.
  offGrowth?: {span: number; start: number},
): string {
  if (off == null || on == null) return 'CANNOT JUDGE (an arm did not measure)';
  if (cap != null && offMax != null && offMax < cap) {
    return `CANNOT JUDGE (the OFF arm peaked at ${formatNumber(offMax)}, below the cap ${formatNumber(cap)} the fix enforces)`;
  }
  const NOISE = 0.01;
  if (offGrowth != null && off > NOISE) {
    const grew = off * offGrowth.span;
    // From an empty start there is no relative scale; the absolute floor
    // alone decides.
    const relativelySmall =
      offGrowth.start === 0 || grew < 0.05 * Math.abs(offGrowth.start);
    if (grew < 50 && relativelySmall) {
      return `CANNOT JUDGE (the OFF arm grew only ~${formatNumber(Math.round(grew))} on ${formatNumber(offGrowth.start)})`;
    }
  }
  if (off <= NOISE) {
    return on > NOISE
      ? 'REGRESSION? (grows only with the fix ON)'
      : 'CANNOT JUDGE (no growth in either arm)';
  }
  // An ON arm that does not grow (or shrinks) kept none of the growth; a
  // negative ratio would print an impossible "−160%".
  if (on <= NOISE) return '**FIX EFFECTIVE** (−100%; the ON arm does not grow)';
  const kept = on / off;
  if (kept <= 0.2)
    return `**FIX EFFECTIVE** (−${((1 - kept) * 100).toFixed(0)}%)`;
  if (kept >= 0.8) return 'NO EFFECT';
  return `PARTIAL (−${((1 - kept) * 100).toFixed(0)}%)`;
}

export function registerAbCompare(server: McpServer): void {
  server.tool(
    'memlab_ab_compare',
    "Judge an A/B round (`hunt_runner --ab`) in one call: run the same probes on the OFF arm and the ON arm, fit each arm against its own cycles, and print one table with per-cycle rates, the ON/OFF ratio and a verdict per metric — FIX EFFECTIVE / PARTIAL / NO EFFECT / CANNOT JUDGE. Each arm's heap total is a row too, production-only beside raw, so a dev-only resize in one arm is not read as that arm growing more. " +
      'Reads the arms from run.json `ab`. Probes are `memlab_eval` code assigning a number to `result` (as in `memlab_ladder_probe`); `census` adds built-in `memlab_census` populations. Give a metric a `cap` when the fix bounds a population at a size: a round whose OFF arm never reached the cap cannot show the fix working, and is reported CANNOT JUDGE rather than NO EFFECT.',
    {
      run_dir: z.string().describe('The A/B round directory (holds run.json).'),
      metrics: z
        .record(
          z.union([
            z.string(),
            z.object({code: z.string(), cap: z.number().optional()}),
          ]),
        )
        .optional()
        .describe(
          'name -> probe code, or name -> {code, cap}. Each probe assigns a number to `result`.',
        ),
      probes: z
        .string()
        .optional()
        .describe(
          "A probe set saved with `memlab_probes`, compared alongside `metrics` (with each probe's `cap`). Without `metrics`, the set whose `match` appears in the round's URL filter is used.",
        ),
      census: z
        .array(z.string())
        .optional()
        .describe(
          `Built-in census populations to compare too: ${BUILTIN.map(m => m.name).join(', ')}.`,
        ),
      prelude: z
        .string()
        .optional()
        .describe('Source run before every probe (shared helpers).'),
      timeout_ms: z
        .number()
        .optional()
        .describe(
          'Per-rung probe timeout; scaled from the largest rung by default.',
        ),
      max_nodes: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(20000000)
        .describe('Per-rung node-visit budget for full-heap walks.'),
      totals: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          `Add rows for each arm's heap total: "${PROD_TOTAL}" (memory only a dev build holds removed; shown when the build has dev roots) and "${RAW_TOTAL}". Judge an arm by the production row: a dev-only hash table that resizes in one arm moves only the raw one.`,
        ),
    },
    async ({
      run_dir,
      metrics,
      probes: probeSet,
      census,
      prelude,
      timeout_ms,
      max_nodes,
      totals,
    }) => {
      try {
        const specs = Object.entries(
          (metrics ?? {}) as Record<string, MetricSpec>,
        );
        const picked =
          probeSet != null && probeSet !== ''
            ? resolveProbeSet(probeSet, run_dir)
            : specs.length === 0
              ? resolveProbeSet(undefined, run_dir)
              : null;
        if (picked != null) {
          for (const [name, p] of Object.entries(picked.set.probes)) {
            // A metric the caller named wins over a set probe of that name.
            if (specs.some(([n]) => n === name)) continue;
            specs.push([name, {code: p.code, cap: p.cap}]);
          }
          // The set's probes need its prelude; the caller's runs after it.
          if (picked.set.prelude != null) {
            prelude =
              prelude == null
                ? picked.set.prelude
                : `${picked.set.prelude}\n${prelude}`;
          }
        }
        const builtins = BUILTIN.filter(b => (census ?? []).includes(b.name));
        const unknown = (census ?? []).filter(
          c => !BUILTIN.some(b => b.name === c),
        );
        if (unknown.length > 0) {
          return errorResult(
            new Error(
              `Unknown census population(s): ${unknown.join(', ')}. Known: ${BUILTIN.map(b => b.name).join(', ')}.`,
            ),
          );
        }
        if (specs.length === 0 && builtins.length === 0 && !totals) {
          return errorResult(
            new Error(
              'Pass `metrics` (probe code) and/or `census` populations, or leave `totals` on.',
            ),
          );
        }
        const arms = readArms(run_dir);
        const probes = specs.map(([name, spec]) => ({
          name,
          code: typeof spec === 'string' ? spec : spec.code,
        }));
        const caps = new Map(
          specs.map(([name, spec]) => [
            name,
            typeof spec === 'string' ? undefined : spec.cap,
          ]),
        );
        const names = [
          ...probes.map(p => p.name),
          ...builtins.map(b => b.name),
          ...(totals ? [PROD_TOTAL, RAW_TOTAL] : []),
        ];
        // Series are keyed by name; two metrics sharing one would interleave.
        const dup = names.find((n, i) => names.indexOf(n) !== i);
        if (dup != null) {
          return errorResult(
            new Error(
              `metric name "${dup}" is used twice (a \`metrics\` key and a \`census\` population share it); rename one.`,
            ),
          );
        }

        // arm -> metric -> per-rung value
        const values = new Map<string, Map<string, Array<number | null>>>();
        const errors: string[] = [];
        // metric -> arm -> first probe error, so a probe that fails on every
        // rung of an arm says WHY in its verdict instead of "did not measure".
        const firstError = new Map<string, Map<string, string>>();
        for (const arm of arms) {
          const perMetric = new Map<string, Array<number | null>>(
            names.map(n => [n, []]),
          );
          const {rungs, largestMB} = resolveRungs(arm.paths);
          // The fits pair arm.cycles with these values by position, so the
          // two must describe the same rungs.
          if (rungs.length !== arm.cycles.length) {
            throw new Error(
              `${arm.name} arm: ${rungs.length} snapshot(s) but ${arm.cycles.length} cycle count(s) in run.json; refusing to pair them by position.`,
            );
          }
          const timeout = scaledTimeoutMs(largestMB, timeout_ms);
          const recordError = (
            name: string,
            rungLabel: string,
            msg: string,
          ) => {
            const byArm = firstError.get(name) ?? new Map();
            if (!byArm.has(arm.name)) byArm.set(arm.name, msg);
            firstError.set(name, byArm);
            if (errors.length < 5) {
              errors.push(`${arm.name} ${rungLabel} ${name}: ${msg}`);
            }
          };
          for (const rung of rungs) {
            armScanBudgetFor(timeout);
            // One parse per rung: the probes' own load borrows this one, and
            // the census reads the same graph. An unreadable rung costs that
            // rung's values, not the whole comparison.
            let measured: {
              out: Awaited<ReturnType<typeof probeRung>>;
              counts: Map<string, number> | null;
              heap: {raw: number; prod: number | null} | null;
            } | null = null;
            try {
              measured = await withSnapshotAt(rung.localPath, async snap => {
                const out =
                  probes.length > 0
                    ? await probeRung(
                        rung.localPath,
                        probes,
                        timeout,
                        max_nodes,
                        prelude,
                      )
                    : new Map();
                let counts: Map<string, number> | null = null;
                if (builtins.length > 0) {
                  try {
                    counts = countOne(snap, builtins, []);
                  } catch (err) {
                    const msg =
                      err instanceof Error ? err.message : String(err);
                    for (const b of builtins) {
                      recordError(b.name, rung.label, `census: ${msg}`);
                    }
                  }
                }
                return {out, counts, heap: totals ? heapTotals(snap) : null};
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              for (const n of names) recordError(n, rung.label, msg);
            }
            for (const p of probes) {
              const o = measured?.out.get(p.name);
              const value = o?.value ?? null;
              // NaN or Infinity is not a reading; it fails the rung like an
              // error would.
              const nonFinite = value != null && !Number.isFinite(value);
              perMetric.get(p.name)?.push(nonFinite ? null : value);
              const error =
                o?.error ?? (nonFinite ? `returned ${value}` : null);
              if (error != null) recordError(p.name, rung.label, error);
            }
            for (const b of builtins) {
              perMetric
                .get(b.name)
                ?.push(measured?.counts?.get(b.name) ?? null);
            }
            if (totals) {
              perMetric.get(PROD_TOTAL)?.push(measured?.heap?.prod ?? null);
              perMetric.get(RAW_TOTAL)?.push(measured?.heap?.raw ?? null);
            }
          }
          values.set(arm.name, perMetric);
        }

        const [off, on] = arms;
        // Some rungs missing: the verdict is fitted on the rest, and says so.
        const partialNote = (
          offYs: Array<number | null>,
          onYs: Array<number | null>,
        ): string => {
          const missing = [...offYs, ...onYs].filter(v => v == null).length;
          return missing > 0
            ? `(${missing} rung(s) failed; fitted on the rest) `
            : '';
        };
        const failedArm = (
          name: string,
          offYs: Array<number | null>,
          onYs: Array<number | null>,
        ): string | null => {
          for (const [arm, ys] of [
            ['off', offYs],
            ['on', onYs],
          ] as const) {
            const err = firstError.get(name)?.get(arm);
            if (ys.length > 0 && ys.every(v => v == null) && err != null) {
              return `CANNOT JUDGE (probe failed on every ${arm.toUpperCase()} rung: ${err.slice(0, 80)})`;
            }
          }
          return null;
        };
        // No dev roots on either arm: the production row would repeat the raw
        // one as "did not measure".
        const shown = names.filter(
          name =>
            name !== PROD_TOTAL ||
            arms.some(arm =>
              (values.get(arm.name)?.get(name) ?? []).some(v => v != null),
            ),
        );
        const rows = shown.map(name => {
          const offYs = values.get('off')?.get(name) ?? [];
          const onYs = values.get('on')?.get(name) ?? [];
          const offFit = rateOf(off.cycles, offYs);
          const onFit = rateOf(on.cycles, onYs);
          const offNums = offYs.filter((v): v is number => v != null);
          const offMax = offNums.length > 0 ? Math.max(...offNums) : null;
          const fmt = (f: ReturnType<typeof rateOf>) =>
            f == null
              ? '—'
              : `${f.slope >= 0 ? '+' : ''}${f.slope.toFixed(3)} (r² ${f.r2.toFixed(2)})`;
          const ratio =
            offFit != null && onFit != null && Math.abs(offFit.slope) > 1e-9
              ? (onFit.slope / offFit.slope).toFixed(2)
              : '—';
          return [
            name,
            offYs.map(v => (v == null ? '—' : formatNumber(v))).join(' → '),
            fmt(offFit),
            onYs.map(v => (v == null ? '—' : formatNumber(v))).join(' → '),
            fmt(onFit),
            ratio,
            failedArm(name, offYs, onYs) ??
              partialNote(offYs, onYs) +
                abVerdict(
                  offFit?.slope ?? null,
                  onFit?.slope ?? null,
                  offMax,
                  caps.get(name),
                  offGrowth(off.cycles, offYs),
                ),
          ];
        });

        const lines = [
          `## A/B: \`${off.prop ?? '?'}\` = ${JSON.stringify(off.value)} (OFF) vs ${JSON.stringify(on.value)} (ON)`,
          '',
          `OFF arm: ${off.paths.length} rungs, cycles ${off.cycles.join(', ')}. ON arm: ${on.paths.length} rungs, cycles ${on.cycles.join(', ')}. Each arm is fitted against its own cycles.`,
          '',
          ...(picked != null
            ? [
                `_Probe set \`${picked.name}\`${picked.auto ? ` (its \`match\` \`${picked.set.match}\` is in the round's URL filter)` : ''}._`,
                '',
              ]
            : []),
          markdownTable(
            [
              'Metric',
              'OFF series',
              'OFF Δ/cycle',
              'ON series',
              'ON Δ/cycle',
              'ON/OFF',
              'Verdict',
            ],
            rows,
          ),
          '',
        ];
        if (errors.length > 0) {
          lines.push('Probe errors:', ...errors.map(e => `- ${e}`), '');
        }
        if (shown.includes(PROD_TOTAL)) {
          lines.push(
            '_Judge the arm totals by the production-only row. Where the raw row disagrees, the difference is memory only a dev build holds (a Fast Refresh or `_debug*` table resizing in one arm, for example)._',
            '',
          );
        }
        lines.push(
          '_FIX EFFECTIVE = the ON rate is at most 20% of the OFF rate; NO EFFECT = at least 80%. A verdict is about the RATE: a first-mount step shows up in the series but not in the rate. Confirm an effective fix on a second round before filing it — one A/B is one sample._',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
