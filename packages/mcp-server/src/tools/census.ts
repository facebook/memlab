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
import {withSnapshotAt} from '../snapshot-borrow.js';
import {resolveLadderPaths} from './ladder.js';
import {
  cyclesFromFilename,
  loadRunManifest,
  type RunManifest,
} from '../run-manifest.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * A population worth counting on every rung of every round.
 *
 * These are the shapes that actually discriminated findings in practice, which
 * is the bar for being built in: each one separated a real leak from a
 * non-leak at least once. `detached` and `lru_cache_nodes` moved in OPPOSITE
 * directions across one settle rung — the first drained 99.8%, the second did
 * not move by a single node — which is the whole argument for counting several
 * populations per rung rather than reading aggregate heap.
 */
interface Metric {
  name: string;
  describe: string;
  /**
   * True when `match` reads `props`. Building the property set allocates a Set
   * and walks every reference of every node, so on a multi-million-node graph
   * it dominates the pass — and most built-ins match on `node.name` alone and
   * never look at it. Declared rather than inferred so a new metric that needs
   * props cannot silently be handed an empty set.
   */
  needsProps: boolean;
  match: (node: IHeapNode, props: ReadonlySet<string>) => boolean;
}

const BUILTIN: Metric[] = [
  {
    name: 'detached',
    describe: 'Detached DOM nodes (class name starts with "Detached ").',
    needsProps: false,
    match: n => n.name.startsWith('Detached '),
  },
  {
    name: 'listener_records',
    describe:
      'Listener subscription records — an object carrying both a listener/callback and an event type.',
    needsProps: true,
    match: (_n, p) =>
      (p.has('listener') || p.has('callback')) &&
      (p.has('eventType') || p.has('subscriber') || p.has('context')),
  },
  {
    name: 'lru_cache_nodes',
    describe:
      'Doubly-linked LRU cache nodes (`cacheVersion` + `next` + `prev`).',
    needsProps: true,
    match: (_n, p) => p.has('cacheVersion') && p.has('next') && p.has('prev'),
  },
  {
    name: 'lru_caches',
    describe: 'LRU cache instances (`head` + `tail` + `capacity`).',
    needsProps: true,
    match: (_n, p) => p.has('head') && p.has('tail') && p.has('capacity'),
  },
  {
    name: 'react_fibers',
    describe: 'React fibers (`memoizedProps` + `stateNode`).',
    needsProps: true,
    match: (_n, p) => p.has('memoizedProps') && p.has('stateNode'),
  },
  {
    name: 'react_profiler_fibers',
    describe:
      'React fibers carrying PROFILER timings (`treeBaseDuration`) — present only when the profiling build is shipped.',
    needsProps: true,
    match: (_n, p) => p.has('treeBaseDuration') && p.has('memoizedProps'),
  },
  {
    name: 'array_buffers',
    describe: 'ArrayBuffer instances.',
    needsProps: false,
    match: n => n.name === 'ArrayBuffer',
  },
  {
    name: 'promise_reactions',
    describe:
      'Pending promise reactions — usually in-flight backlog, so read them against the settle rung.',
    needsProps: false,
    match: n => n.name === 'system / PromiseReaction',
  },
  {
    name: 'timers',
    describe: 'DOM timers still registered.',
    needsProps: false,
    match: n => n.name === 'DOMTimer' || n.name === 'blink::DOMTimer',
  },
  {
    name: 'external_strings',
    describe: 'Source-text backing stores (`system / ExternalStringData`).',
    needsProps: false,
    match: n => n.name === 'system / ExternalStringData',
  },
  {
    name: 'code_objects',
    describe:
      'Compiled-code objects (bytecode, instruction streams). Together with external_strings these are the loaded-JavaScript cost, which on a real web app is the largest thing in the heap and is a STANDING cost rather than a leak.',
    needsProps: false,
    match: n =>
      n.name === 'system / InstructionStream' ||
      n.name === 'system / BytecodeArray' ||
      n.name === 'system / TrustedByteArray',
  },
  {
    name: 'text_records',
    describe:
      'Blink paint-timing text records — these accumulate after LCP is final on some builds.',
    needsProps: false,
    match: n => n.name === 'blink::TextRecord',
  },
];

/** Handed to name-only matchers so no Set is allocated per node. */
const EMPTY_PROPS: ReadonlySet<string> = new Set<string>();

function propsOf(node: IHeapNode): Set<string> {
  const out = new Set<string>();
  for (const e of node.references) {
    if (e.type === 'property') out.add(String(e.name_or_index));
  }
  return out;
}

interface RungCount {
  label: string;
  cycles: number | null;
  counts: Map<string, number>;
}

function countOne(
  snapshot: IHeapSnapshot,
  metrics: Metric[],
  classNames: string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of metrics) counts.set(m.name, 0);
  for (const c of classNames) counts.set(`class:${c}`, 0);
  const wantedClasses = new Set(classNames);
  // A `metrics` subset of name-only matchers never reads the property set, and
  // building one per node is then the dominant cost of the whole pass.
  const anyNeedsProps = metrics.some(m => m.needsProps);
  // ONE pass for every metric. Counting them separately is what makes an
  // eval-based census abort: the node budget is cumulative, so a second
  // forEach over a multi-million-node graph runs out part-way through.
  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;
    if (wantedClasses.size > 0 && wantedClasses.has(node.name)) {
      counts.set(
        `class:${node.name}`,
        (counts.get(`class:${node.name}`) ?? 0) + 1,
      );
    }
    const props = anyNeedsProps ? propsOf(node) : EMPTY_PROPS;
    for (const m of metrics) {
      if (m.match(node, props))
        counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
    }
  });
  return counts;
}

/** Least-squares slope of y against x; null when the axis is degenerate. */
function slope(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

export function registerCensus(server: McpServer): void {
  server.tool(
    'memlab_census',
    "Count several named POPULATIONS across every rung of a ladder in ONE pass per snapshot, and report each one's per-cycle rate.\n\n" +
      'This is the measurement a leak hunt actually repeats: "how many detached nodes / listener records / LRU cache nodes / fibers are there, ' +
      'at each rung, and is that number going up?" Doing it by hand means writing the same multi-flag `forEach` once per round and re-typing it ' +
      'for every metric — and a second pass over a multi-million-node graph aborts, because the eval node budget is cumulative. ' +
      'Every built-in metric here separated a real leak from a non-leak at least once.\n\n' +
      'Pair it with the settle rung: a population that keeps rising across the driven rungs AND does not move across the settle rung is a leak; ' +
      'one that collapses on the settle rung was in-flight backlog. Those two verdicts are indistinguishable from aggregate heap.',
    {
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Ordered snapshot paths, oldest first. Or a single ["ladder:<name>"] reference.',
        ),
      run_dir: z
        .string()
        .optional()
        .describe(
          'A leak-hunt run directory; takes the rung paths and the cycle axis from its run.json. Includes the settle rung when the round has one.',
        ),
      metrics: z
        .array(z.string())
        .optional()
        .describe(
          'Which built-in metrics to count (default: all). Names: ' +
            BUILTIN.map(m => m.name).join(', ') +
            '.',
        ),
      class_names: z
        .array(z.string())
        .optional()
        .describe(
          'Extra exact heap class names to count alongside the built-ins, e.g. ["AdsPENavigationProviderPlugin"].',
        ),
      cycles: z
        .array(z.number())
        .optional()
        .describe(
          'Cumulative cycle count at each rung. Without it the rate is per RUNG, and two rounds with different spacing are not comparable.',
        ),
    },
    async ({paths, run_dir, metrics, class_names, cycles}) => {
      try {
        let rungPaths: string[] = [];
        let axis: number[] | null = cycles ?? null;
        let settlePath: string | null = null;

        if (run_dir != null) {
          let manifest: RunManifest;
          try {
            manifest = loadRunManifest(run_dir);
          } catch (e) {
            return errorResult(e);
          }
          rungPaths = manifest.paths;
          axis = axis ?? manifest.cyclesPerRung;
          settlePath = manifest.settleRungPath;
        } else if (paths != null && paths.length > 0) {
          rungPaths = resolveLadderPaths(paths).paths;
        } else {
          return errorResult(
            new Error('Pass either run_dir or paths (oldest rung first).'),
          );
        }
        if (rungPaths.length === 0) {
          return errorResult(new Error('No rungs to census.'));
        }

        const chosen =
          metrics == null
            ? BUILTIN
            : BUILTIN.filter(m => metrics.includes(m.name));
        // A typo in ONE name used to be dropped in silence, so the census came
        // back missing a population the caller believed it had asked for —
        // indistinguishable from that population being absent from the heap.
        const unknownMetrics =
          metrics == null
            ? []
            : metrics.filter(m => !BUILTIN.some(b => b.name === m));
        if (unknownMetrics.length > 0 && chosen.length > 0) {
          return errorResult(
            new Error(
              `Unknown metric(s): ${unknownMetrics.join(', ')}. Known: ${BUILTIN.map(m => m.name).join(', ')}. ` +
                'Re-run without them, or fix the spelling — a partial census reads exactly like an absent population.',
            ),
          );
        }
        if (chosen.length === 0) {
          return errorResult(
            new Error(
              `No known metric in ${JSON.stringify(metrics)}. Known: ${BUILTIN.map(m => m.name).join(', ')}.`,
            ),
          );
        }
        const classes = class_names ?? [];

        const rows: RungCount[] = [];
        for (let i = 0; i < rungPaths.length; i++) {
          const p = rungPaths[i];
          const counts = await withSnapshotAt(p, async (snap: IHeapSnapshot) =>
            countOne(snap, chosen, classes),
          );
          rows.push({
            label: p.replace(/^.*\//, ''),
            cycles: axis?.[i] ?? cyclesFromFilename(p),
            counts,
          });
        }
        let settleRow: RungCount | null = null;
        if (settlePath != null) {
          const counts = await withSnapshotAt(
            settlePath,
            async (snap: IHeapSnapshot) => countOne(snap, chosen, classes),
          );
          settleRow = {
            label: settlePath.replace(/^.*\//, ''),
            cycles: null,
            counts,
          };
        }

        const keys = [...rows[0].counts.keys()];
        const haveCycles = rows.every(r => r.cycles != null);
        // All cycles or all indices — never a mixture. A partial axis puts
        // cycle counts in the hundreds next to rung indices of 0..3 on the
        // same regression, and the slope it produces is not a rate in either
        // unit. The header already says which unit is in play.
        const xs = haveCycles
          ? rows.map(r => r.cycles as number)
          : rows.map((_, i) => i);

        const table = keys.map(k => {
          const ys = rows.map(r => r.counts.get(k) ?? 0);
          const s = slope(xs, ys);
          const settled = settleRow?.counts.get(k);
          const last = ys[ys.length - 1];
          let verdict = '—';
          if (settled != null) {
            // `settled > last` and `last === 0 && settled > 0` are their own
            // answers, not weaker forms of "drained". A population that is
            // LARGER after idle drained nothing, and one that appears only on
            // the settle rung is the signal the old `absent` label hid.
            if (last === 0)
              verdict = settled > 0 ? 'appeared only after settle' : 'absent';
            else if (settled > last) verdict = 'grew after settle';
            else if (settled === last) verdict = '**PERMANENT** (no drain)';
            else if (settled <= last * 0.1)
              verdict = '**BACKLOG** (drained ≥90%)';
            else verdict = 'partial drain';
          }
          return [
            k,
            ...ys.map(v => formatNumber(v)),
            ...(settled != null ? [formatNumber(settled)] : []),
            s == null ? '—' : s.toFixed(2),
            verdict,
          ];
        });

        const headers = [
          'Population',
          ...rows.map(r =>
            r.cycles != null ? `c${r.cycles}` : r.label.slice(0, 14),
          ),
          ...(settleRow != null ? ['settled'] : []),
          haveCycles ? 'Δ/cycle' : 'Δ/rung',
          'Settle verdict',
        ];

        const lines = [
          '## Census',
          '',
          `${formatNumber(rows.length)} rung(s)${settleRow != null ? ' + a settle rung' : ''}, ` +
            `${formatNumber(keys.length)} population(s), one pass per snapshot.`,
          '',
          markdownTable(headers, table),
          '',
          // NOT `''` — a `.filter(Boolean)` over `lines` would strip the
          // deliberate blank-line separators too and collapse the whole report
          // into unreadable markdown.
          ...(haveCycles
            ? []
            : [
                '_No cycle axis: rates are per RUNG, so they are NOT comparable with a round driven at different spacing. Pass `cycles`, or use `run_dir`._',
              ]),
          settleRow == null
            ? '_⚠ No settle rung in this round, so no population here can be called a leak — a rising count is equally consistent with in-flight backlog. Re-drive with the runner default (`--settle-minutes 7`)._'
            : '_A population that rises across the driven rungs and does NOT move across the settle rung is retention. One that collapses was backlog. Both look identical on a growth ladder._',
        ];
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
