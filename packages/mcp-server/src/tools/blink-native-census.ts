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
import type {IHeapEdge, IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {withSnapshotAt} from '../snapshot-borrow.js';
import {loadRunManifest} from '../run-manifest.js';
import {resolveLadderPaths} from './ladder.js';
import {linearFit} from './ladder-probe.js';
import {
  abbreviateBlinkTypeName,
  clampLabel,
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * Native (Blink) objects that grow across a ladder, split by WHO holds them.
 *
 * A growing native class is either pinned by JavaScript — a promise reaction,
 * an app array — which an app change can release, or held inside the browser
 * (the performance timeline, soft-navigation heuristics), which it cannot.
 * Without the split every one of them reads as a leak candidate, and the
 * bounded browser buffers among them come back every round.
 */

/**
 * Browser buffers with a fixed capacity: growth that stops at the cap is the
 * buffer filling, not a leak. Capacities are the specs' defaults.
 */
const BOUNDED_BUFFERS: ReadonlyMap<string, {cap: number; what: string}> =
  new Map([
    ['PerformanceEventTiming', {cap: 150, what: 'Event Timing buffer'}],
    ['LayoutShift', {cap: 150, what: 'Layout Instability buffer'}],
    [
      'LayoutShiftAttribution',
      {cap: 750, what: 'Layout Instability buffer (5 sources per shift)'},
    ],
    ['LargestContentfulPaint', {cap: 150, what: 'LCP buffer'}],
    ['PerformanceResourceTiming', {cap: 250, what: 'Resource Timing buffer'}],
    ['PerformanceLongTaskTiming', {cap: 200, what: 'Long Tasks buffer'}],
    ['PerformanceLongAnimationFrameTiming', {cap: 200, what: 'LoAF buffer'}],
  ]);

const PERF_CLASS_RE =
  /^(Performance\w+|LayoutShift\w*|LargestContentfulPaint|TaskAttributionInfo\w*|DOMRectReadOnly)$/;

function isNativeClass(node: IHeapNode): boolean {
  if (node.id <= 3) return false;
  if (node.name.startsWith('blink::')) return true;
  if (node.type === 'native' && !node.name.startsWith('Detached ')) {
    return node.name !== '' && !node.name.startsWith('system /');
  }
  return PERF_CLASS_RE.test(node.name);
}

function isJsHolder(node: IHeapNode): boolean {
  return (
    (node.type === 'object' ||
      node.type === 'closure' ||
      node.type === 'array') &&
    !node.name.startsWith('system /') &&
    !node.name.startsWith('blink::') &&
    !PERF_CLASS_RE.test(node.name)
  );
}

/**
 * An anonymous holder named by its first few property names, so structurally
 * different anonymous objects are not merged into one "(anonymous)" holder.
 */
function shapeOf(node: IHeapNode): string {
  const keys: string[] = [];
  for (const e of node.references) {
    if (e.type === 'property' && String(e.name_or_index) !== '__proto__') {
      keys.push(String(e.name_or_index));
    }
  }
  if (keys.length === 0) return '(anonymous)';
  keys.sort();
  return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}}`;
}

/**
 * Walk the shortest retainer path up from `node`: the first JavaScript object
 * on it is the holder an app change could release. A path that reaches a GC
 * root through native objects only is browser-internal. `js: null` when the
 * walk gave up (hop limit or a loop) before either: unresolved, not native.
 */
function classifyHolder(node: IHeapNode): {js: boolean | null; label: string} {
  let cur: IHeapNode | null = node;
  let firstNative: string | null = null;
  const seen = new Set<number>([node.id]);
  for (let hops = 0; cur != null && cur.hasPathEdge; hops++) {
    if (hops >= 40) return {js: null, label: '(path over 40 hops)'};
    const edge: IHeapEdge | null = cur.pathEdge;
    if (edge == null) break;
    const from: IHeapNode = edge.fromNode;
    if (seen.has(from.id)) return {js: null, label: '(path loops)'};
    seen.add(from.id);
    if (isJsHolder(from)) {
      // Element indices are folded so one array holding many is one holder.
      const slot =
        edge.type === 'element' ? '[]' : `.${String(edge.name_or_index)}`;
      return {js: true, label: `${from.name || shapeOf(from)}${slot}`};
    }
    if (firstNative == null && from.id > 3 && from.name !== '') {
      firstNative = from.name;
    }
    cur = from;
  }
  return {js: false, label: firstNative ?? '(GC root)'};
}

function countNative(snapshot: IHeapSnapshot): Map<string, number> {
  const out = new Map<string, number>();
  snapshot.nodes.forEach(node => {
    if (!isNativeClass(node)) return;
    out.set(node.name, (out.get(node.name) ?? 0) + 1);
  });
  return out;
}

interface Split {
  js: number;
  blink: number;
  topJs: string | null;
  topBlink: string | null;
  /** Sampled instances whose holder walk gave up; counted as neither. */
  unresolved: number;
}

function splitHolders(
  snapshot: IHeapSnapshot,
  classes: Set<string>,
  sample: number,
): Map<string, Split> {
  // The NEWEST instances (highest ids) are the growth cohort. Every id of a
  // grower class is kept and sorted once: only grower classes are collected,
  // and plain ids are cheap even for tens of thousands of instances.
  const ids = new Map<string, number[]>();
  snapshot.nodes.forEach(node => {
    if (!classes.has(node.name) || !isNativeClass(node)) return;
    const list = ids.get(node.name) ?? [];
    list.push(node.id);
    ids.set(node.name, list);
  });
  const newest = new Map<string, IHeapNode[]>();
  for (const [name, list] of ids) {
    list.sort((a, b) => b - a);
    newest.set(
      name,
      list
        .slice(0, sample)
        .map(id => snapshot.getNodeById(id))
        .filter((n): n is IHeapNode => n != null),
    );
  }
  const out = new Map<string, Split>();
  for (const [name, list] of newest) {
    list.sort((a, b) => b.id - a.id);
    const jsLabels = new Map<string, number>();
    const blinkLabels = new Map<string, number>();
    let js = 0;
    let blink = 0;
    let unresolved = 0;
    for (const node of list.slice(0, sample)) {
      const h = classifyHolder(node);
      if (h.js == null) {
        unresolved++;
        continue;
      }
      const bucket = h.js ? jsLabels : blinkLabels;
      bucket.set(h.label, (bucket.get(h.label) ?? 0) + 1);
      if (h.js) js++;
      else blink++;
    }
    const top = (m: Map<string, number>) => {
      const label = [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
      return label == null
        ? null
        : clampLabel(abbreviateBlinkTypeName(label), 70);
    };
    out.set(name, {
      js,
      blink,
      unresolved,
      topJs: top(jsLabels),
      topBlink: top(blinkLabels),
    });
  }
  return out;
}

export function registerBlinkNativeCensus(server: McpServer): void {
  server.tool(
    'memlab_blink_native_census',
    'Native (Blink) classes that grow across a ladder — `blink::*`, performance-timeline entries, other `native` objects — each split by WHO holds its newest instances: a JavaScript holder (a promise reaction, an app array; an app change can release it) or the browser itself (performance timeline, soft-navigation heuristics; it cannot). ' +
      'Known fixed-capacity browser buffers (Event Timing, Layout Instability, LCP, Resource Timing, Long Tasks) are annotated with their cap, so a buffer filling up is not reported as a leak. Takes `run_dir` or `paths`.',
    {
      run_dir: z
        .string()
        .optional()
        .describe(
          'A leak-hunt run directory (rungs and cycle axis from run.json).',
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe('Ordered snapshot paths, oldest first, instead of run_dir.'),
      min_growth: z
        .number()
        .min(0)
        .optional()
        .default(10)
        .describe(
          'Only classes whose count grew by at least this (default 10).',
        ),
      sample: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(20)
        .describe(
          'Newest instances per class whose holder is classified (default 20).',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(20)
        .describe('Rows to show (default 20).'),
    },
    async ({run_dir, paths, min_growth, sample, limit}) => {
      try {
        let rungPaths: string[];
        let axis: number[] | null = null;
        if (run_dir != null) {
          const m = loadRunManifest(run_dir);
          rungPaths = m.paths;
          axis = m.cyclesPerRung;
        } else if (paths != null && paths.length > 0) {
          rungPaths = resolveLadderPaths(paths).paths;
        } else {
          return errorResult(
            new Error('Pass run_dir or paths (oldest first).'),
          );
        }
        if (rungPaths.length < 2) {
          return errorResult(new Error('Need at least two rungs.'));
        }
        const perRung: Array<Map<string, number>> = [];
        for (const p of rungPaths.slice(0, -1)) {
          perRung.push(await withSnapshotAt(p, snap => countNative(snap)));
        }
        // An axis that does not match the rungs is dropped, so the rate is
        // labeled per rung rather than mislabeled per cycle.
        if (axis != null && axis.length !== rungPaths.length) axis = null;
        const xs = axis ?? rungPaths.map((_, i) => i);
        // The last rung is counted and classified in one load.
        const {
          counts: lastCounts,
          splits,
          lateOnly,
          documents,
        } = await withSnapshotAt(rungPaths[rungPaths.length - 1], snap => {
          const counts = countNative(snap);
          // Buffer caps are per document; the counts are heap-wide.
          let docs = 0;
          snap.nodes.forEach(n => {
            if (n.name === 'HTMLDocument') docs++;
          });
          const all = [...perRung, counts];
          // Grew by min_growth AND had already grown before the last rung:
          // a class that appears only on the final snapshot is a spike, not
          // a multi-rung grower.
          const prev = all[all.length - 2];
          const grew = [...counts.keys()].filter(
            k => (counts.get(k) ?? 0) - (all[0].get(k) ?? 0) >= min_growth,
          );
          const before = (k: string) =>
            all.length < 3 || (prev.get(k) ?? 0) > (all[0].get(k) ?? 0);
          // Last-rung-only jumps are named, not dropped: a late-onset
          // grower looks the same until another rung tells them apart.
          return {
            counts,
            splits: splitHolders(snap, new Set(grew.filter(before)), sample),
            lateOnly: grew.filter(k => !before(k)),
            documents: Math.max(1, docs),
          };
        });
        perRung.push(lastCounts);

        const fitted = [...splits.keys()]
          .map(name => {
            const ys = perRung.map(m => m.get(name) ?? 0);
            const fit = linearFit(xs, ys);
            return {
              name,
              ys,
              slope: fit.slope,
              split: splits.get(name) as Split,
            };
          })
          .sort((a, b) => b.slope - a.slope);
        // A class that peaked and is now draining is not "growing", whatever
        // it ended above, so it leaves the table; it is named below rather
        // than dropped without a trace.
        const rows = fitted.filter(r => r.slope > 0);
        const drainingNames = fitted.filter(r => r.slope <= 0).map(r => r.name);
        const drainNote =
          drainingNames.length > 0
            ? `_${formatNumber(drainingNames.length)} class(es) ended ${formatNumber(min_growth)}+ above the first rung but trend down (peaked earlier, now draining), so they are not in the table: ${drainingNames
                .slice(0, 6)
                .map(n => `\`${n.length > 48 ? `${n.slice(0, 45)}…` : n}\``)
                .join(
                  ', ',
                )}. Check one with \`memlab_settle_check\` before dismissing it._`
            : null;
        const lateNote =
          lateOnly.length > 0
            ? `_${formatNumber(lateOnly.length)} class(es) grew by ${formatNumber(min_growth)}+ only on the last rung and are not classified: ${lateOnly
                .slice(0, 6)
                .map(n => `\`${n.length > 48 ? `${n.slice(0, 45)}…` : n}\``)
                .join(
                  ', ',
                )}. A spike and a late-onset leak look alike here; drive more rungs to tell them apart._`
            : null;
        if (rows.length === 0) {
          return toolResult(
            [
              `No native class both grew by ${formatNumber(min_growth)} or more from the first rung and has a rising per-rung trend across ${rungPaths.length} rungs.`,
              ...(lateNote != null ? ['', lateNote] : []),
              ...(drainNote != null ? ['', drainNote] : []),
            ].join('\n'),
          );
        }
        const unit = axis != null ? 'cycle' : 'rung';
        const table = rows.slice(0, limit).map(r => {
          const buf = BOUNDED_BUFFERS.get(r.name);
          const last = r.ys[r.ys.length - 1];
          const sampled = r.split.js + r.split.blink + r.split.unresolved;
          const cap = buf != null ? buf.cap * documents : 0;
          const capText =
            buf == null
              ? ''
              : `cap ${formatNumber(buf.cap)}${documents > 1 ? ` × ${documents} documents` : ''}`;
          let note: string;
          // JS holders win over the buffer annotation: a capped buffer whose
          // newest entries are held by app code is that app code's leak.
          if (r.split.js > 0 && r.split.js >= r.split.blink) {
            note =
              `**JS-held** — app-releasable (${r.split.topJs})` +
              (buf != null ? `; also a ${buf.what} (${capText})` : '');
          } else if (r.split.unresolved > r.split.js + r.split.blink) {
            // Judging on the few walks that resolved would let two
            // browser-held samples clear eighteen unknown ones.
            note = `holders mostly unresolved (${r.split.unresolved}/${sampled} sampled walks gave up) — trace one with \`memlab_retainer_trace\``;
          } else if (buf != null && last <= cap * 1.1) {
            // JS-held entries outlive the buffer's eviction, so only an
            // entirely browser-held buffer is cleared as not a leak.
            note =
              r.split.js === 0
                ? `bounded: ${buf.what} (${capText}) — not a leak`
                : `bounded: ${buf.what} (${capText}), but ${r.split.js}/${sampled} are JS-held (${r.split.topJs}) and outlive its eviction — trace one`;
          } else if (buf != null && r.split.js === 0) {
            note = `${buf.what} past its ${capText} — something else holds them`;
          } else if (r.split.js > 0) {
            note =
              `mostly browser-held; ${r.split.js}/${sampled} via JS (${r.split.topJs})` +
              (buf != null ? `; ${buf.what} past its ${capText}` : '');
          } else {
            note = `browser-internal (${r.split.topBlink})`;
          }
          return [
            r.name.length > 48 ? `${r.name.slice(0, 45)}…` : r.name,
            r.ys.map(v => formatNumber(v)).join(' → '),
            `${r.slope >= 0 ? '+' : ''}${r.slope.toFixed(3)}`,
            `${r.split.js} / ${r.split.blink}` +
              (r.split.unresolved > 0
                ? ` (+${r.split.unresolved} unresolved)`
                : ''),
            note,
          ];
        });
        return toolResult(
          [
            `## Native classes growing across ${rungPaths.length} rungs`,
            '',
            markdownTable(
              [
                'Class',
                'Series',
                `Δ/${unit}`,
                'JS / browser holders (newest)',
                'Holder',
              ],
              table,
            ),
            '',
            ...(lateNote != null ? [lateNote, ''] : []),
            ...(drainNote != null ? [drainNote, ''] : []),
            '_JS / browser holders: of the newest instances sampled, how many have a JavaScript object on their shortest retainer path (an app change can release them) versus a path through browser objects only. A JS-held native grower is worth a `memlab_retainer_trace` on one of its newest instances; a browser-internal one usually is not app-fixable._',
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
