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
import fs from 'fs';
import path from 'path';
import {z} from 'zod';
import {getSnapshotByHandle} from '../heap-state.js';
import {withSnapshotAt} from '../snapshot-borrow.js';
import {
  clampLabel,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';
import {normalizeClassName, splitClassKey} from './sequence-analysis.js';

interface ClassStats {
  count: number;
  selfSize: number;
}

function histogram(snapshot: IHeapSnapshot): Map<string, ClassStats> {
  const hist = new Map<string, ClassStats>();
  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;
    const key = `${node.type}::${normalizeClassName(node.name)}`;
    const e = hist.get(key);
    if (e) {
      e.count++;
      e.selfSize += node.self_size;
    } else {
      hist.set(key, {count: 1, selfSize: node.self_size});
    }
  });
  return hist;
}

type Verdict = 'drained' | 'mostly-drained' | 'held' | 'still-growing';

function classify(base: number, busy: number, idle: number): Verdict {
  const grew = busy - base;
  if (grew <= 0) return idle > busy ? 'still-growing' : 'held';
  if (idle > busy) return 'still-growing';
  const retainedFraction = (idle - base) / grew;
  if (retainedFraction <= 0.1) return 'drained';
  if (retainedFraction <= 0.5) return 'mostly-drained';
  return 'held';
}

// Without a baseline the denominator is the whole population rather than the
// growth, so a large standing population that barely moves scores the same as
// a leak. The wording is graded accordingly: only the baseline-relative run
// gets to say "leak candidate".
const VERDICT_NOTE: Record<Verdict, string> = {
  drained: 'in-flight work — NOT a leak',
  'mostly-drained': 'mostly transient; small residue',
  held: 'survives idle + GC — leak candidate',
  'still-growing': 'grew further while idle — background accumulation',
};

const VERDICT_NOTE_NO_BASELINE: Record<Verdict, string> = {
  drained: 'almost entirely reclaimed by settling',
  'mostly-drained': 'largely reclaimed by settling',
  held: 'largely retained — cannot tell growth from standing population here',
  'still-growing': 'larger after idle than during the burst',
};

/** Where the runner writes the settle rung (see hunt_runner.Runner.settle). */
const SETTLE_RUNG_BASENAME = 'rung_99_settle.heapsnapshot';

/**
 * Three LOGICAL rung paths — always the plain `.heapsnapshot` name, even
 * when only `<name>.gz` is on disk after a prune.
 *
 * That is the form the loader takes: `resolveSnapshotPath` resolves the
 * archive transparently, and `snapshotExists` tests both forms. A consumer
 * that instead calls `fs.existsSync`/`statSync` on one of these directly
 * will report a pruned round as missing, which is the one way compression
 * could still become a one-way door.
 */
interface SettlePair {
  busyPath: string;
  settledPath: string;
  baselinePath: string | null;
}

/**
 * Resolve (last driven rung, settle rung, baseline rung) from a run directory.
 *
 * Returns a human-readable string on failure rather than throwing, because the
 * most common failure — the round has no settle rung — is not an error in the
 * caller, it is the finding: that round cannot tell a leak from a backlog and
 * must be recorded as UNSETTLED.
 */
function resolveSettlePair(runDir: string): SettlePair | string {
  const snapsDir = path.join(runDir, 'snapshots');
  const dir = fs.existsSync(snapsDir) ? snapsDir : runDir;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return `Cannot read ${dir}. Pass the run directory the hunt runner wrote (the one containing run.json).`;
  }
  // `.gz` too: a settle rung compressed by `memlab_prune_run` is still a
  // settle rung, and matching only the exact name reported a pruned round as
  // UNSETTLED — the strongest negative this tool emits.
  const settled = entries.find(
    e => e === SETTLE_RUNG_BASENAME || e === `${SETTLE_RUNG_BASENAME}.gz`,
  );
  if (settled == null) {
    return (
      `No settle rung (${SETTLE_RUNG_BASENAME}) in ${dir}.\n\n` +
      'That round was driven without one, so NOTHING in it distinguishes retention ' +
      'from in-flight backlog — two measured sweeps each published a large "leak" ' +
      'that idle then drained by ~99%. Record the round as UNSETTLED rather than as ' +
      'a leak, and re-drive with the runner default (--settle-minutes 7).'
    );
  }
  // Ordered by the NUMERIC rung index, not lexicographically. The runner
  // zero-pads to two digits, so a plain sort agrees with numeric order only
  // while the index stays under 100 — past that `rung_100` sorts before
  // `rung_99` and the wrong file is picked as busy or baseline, silently.
  //
  // De-duplicated by the stripped name: an interrupted compress leaves
  // `rung_NN.heapsnapshot` AND `rung_NN.heapsnapshot.gz` side by side, and
  // counting that rung twice shifts which file is picked as busy or baseline.
  const byName = new Map<string, number>();
  for (const e of entries) {
    if (!/^rung_\d+_c\d+\.heapsnapshot(\.gz)?$/.test(e)) continue;
    byName.set(e.replace(/\.gz$/, ''), Number(/^rung_(\d+)_/.exec(e)?.[1]));
  }
  const driven = [...byName.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(e => e[0]);
  if (driven.length === 0) {
    return `No driven rungs (rung_NN_cNNN.heapsnapshot) in ${dir}.`;
  }
  return {
    busyPath: path.join(dir, driven[driven.length - 1]),
    settledPath: path.join(dir, settled.replace(/\.gz$/, '')),
    baselinePath: driven.length > 1 ? path.join(dir, driven[0]) : null,
  };
}

/**
 * Where the retainer path of a node ENDS, on the GC-root side.
 *
 * Grouping the survivors of a settle by this is the question the settle
 * leaves open: a class that held is a candidate, and whether its instances
 * share ONE root or several decides whether there is one fix or many. Done by
 * hand on two populations in one sweep and decisive both times — 14 of 14 on
 * a single path meant a single root cause.
 */
function retainerSignature(node: IHeapNode): string {
  let cur: IHeapNode | null = node;
  const seen = new Set<number>([node.id]);
  // The nearest NAMED hops, target-ward first, then reversed for reading.
  //
  // Not the literal top of the path: every path ends at `(GC roots)` or a
  // `Window`, so grouping there puts every class in one bucket and the
  // question — do these instances share an owner? — goes unanswered. Three
  // hops is what distinguishes `OwnerA.items` from `OwnerB.items` while still
  // collapsing per-instance noise.
  const hops: string[] = [];
  let depth = 0;
  while (cur != null && cur.hasPathEdge && depth++ < 64 && hops.length < 3) {
    const edge = cur.pathEdge;
    if (edge == null) break;
    const from: IHeapNode = edge.fromNode;
    if (seen.has(from.id)) break;
    seen.add(from.id);
    if (
      from.type !== 'synthetic' &&
      from.name.length > 0 &&
      !from.name.startsWith('(') &&
      !from.name.startsWith('system /')
    ) {
      const edgeName = String(edge.name_or_index);
      // Collapse on the edge TYPE, not on the name looking numeric. The
      // point is to fold array positions — `arr[0]`, `arr[1]` — into one
      // bucket so per-instance noise groups; a `property` edge that happens
      // to be named `0` is a distinct own property of a plain object, and
      // folding it merged owners that share nothing but a digit.
      hops.push(
        edge.type === 'element'
          ? `${from.name}[i]`
          : `${from.name}.${edgeName}`,
      );
    }
    cur = from;
  }
  if (hops.length === 0) return '(no named retainer)';
  return clampLabel(hops.reverse().join(' > '), 70);
}

/**
 * For each HELD class, where its instances' retainer paths end.
 *
 * One extra FULL load of the settled rung (the histogram passes above are
 * light and carry no path edges), which is why it is opt-in.
 */
async function traceHeldClasses(
  settledPath: string,
  heldKeys: readonly string[],
  sampleTarget: number,
): Promise<Map<string, Array<{head: string; count: number}>>> {
  const want = new Set(heldKeys);
  // Two phases over ONE load: collect ids, then trace an EVEN sample of them.
  //
  // Taking the first N encountered is what a one-pass version does, and it is
  // wrong for exactly the population this exists to describe: a class held by
  // two owners is laid out owner by owner, so the first 30 instances are all
  // from the first owner and the split — the finding — reads as 100% on one
  // path.
  const MAX_IDS_PER_CLASS = 200000;
  const idsByClass = new Map<string, number[]>();
  // Instances SEEN per class, which is not `ids.length` once the cap binds.
  const seen = new Map<string, number>();
  // Per class, keep every `stride`-th instance. Doubles each time the buffer
  // fills — see the note at the retention site.
  const strideByClass = new Map<string, number>();
  const out = new Map<string, Array<{head: string; count: number}>>();
  await withSnapshotAt(settledPath, (snap: IHeapSnapshot) => {
    snap.nodes.forEach((node: IHeapNode) => {
      if (node.id <= 3) return;
      if (!node.hasPathEdge) return;
      const key = `${node.type}::${normalizeClassName(node.name)}`;
      if (!want.has(key)) return;
      let ids = idsByClass.get(key);
      if (ids == null) {
        ids = [];
        idsByClass.set(key, ids);
      }
      seen.set(key, (seen.get(key) ?? 0) + 1);
      // Keep every `stride`-th instance, and double the stride (halving what
      // is already held) whenever the buffer fills. The sample that survives
      // is spread evenly across the WHOLE population at every population
      // size, which is the property this needs: a class laid out owner by
      // owner must still show its later owners, or the split that is the
      // finding reads as 100% on one path.
      //
      // Front-truncation keeps the first 200k and a rolling `n % cap`
      // overwrite keeps the LAST 200k — both are layout-order slices, which
      // is the bias the even sampling below exists to remove, reintroduced
      // one level up. Stride-doubling is not a slice, and unlike a random
      // reservoir it is deterministic: two runs over the same snapshot
      // sample the same instances, so a follow-up question lands on the
      // objects the first answer described.
      const n = seen.get(key) as number;
      const stride = strideByClass.get(key) ?? 1;
      if ((n - 1) % stride !== 0) return;
      ids.push(node.id);
      if (ids.length >= MAX_IDS_PER_CLASS) {
        let j = 0;
        for (let i = 0; i < ids.length; i += 2) ids[j++] = ids[i];
        ids.length = j;
        strideByClass.set(key, stride * 2);
      }
    });
    for (const [key, ids] of idsByClass) {
      const take = Math.min(sampleTarget, ids.length);
      const step = ids.length / take;
      const heads = new Map<string, number>();
      for (let i = 0; i < take; i++) {
        const node = snap.getNodeById(ids[Math.floor(i * step)]);
        if (node == null) continue;
        const head = retainerSignature(node);
        heads.set(head, (heads.get(head) ?? 0) + 1);
      }
      out.set(
        key,
        [...heads.entries()]
          .map(([head, count]) => ({head, count}))
          .sort((a, b) => b.count - a.count),
      );
    }
  });
  return out;
}

export function registerSettleCheck(server: McpServer): void {
  server.tool(
    'memlab_settle_check',
    'Separate RETENTION from in-flight BACKLOG by comparing a busy snapshot against one captured after the app settled (idle + forced GC). ' +
      'This is the measurement that a growth ladder alone cannot make: a burst of activity legitimately inflates promise chains, IndexedDB ' +
      'transactions, scheduler queues and request buffers, and every one of those looks exactly like a leak in a two-rung diff. Only a ' +
      'post-idle rung tells them apart — a class that returns to baseline was work in progress, a class that stays is retention.\n\n' +
      'Give it the busy rung and the settled rung (and optionally a pre-activity baseline, which makes the "how much of the growth came back" ' +
      'fraction meaningful rather than absolute). All snapshots must already be resident: load them with `keep_previous: true`.\n\n' +
      'Capture protocol for the settled rung: stop interacting, wait ~30-60s so timers, network callbacks and storage writes complete, force GC, then capture.',
    {
      run_dir: z
        .string()
        .optional()
        .describe(
          'A leak-hunt run directory. Resolves the last DRIVEN rung and the ' +
            'settle rung (rung_99_settle) from it and loads both transiently, ' +
            'so the common case needs no handles and no prior load. The runner ' +
            'writes that rung by default; a round whose run.json says ' +
            '"settled": false has no settle rung and cannot be adjudicated.',
        ),
      busy_handle: z
        .string()
        .optional()
        .describe(
          'Handle of the snapshot taken at peak activity (immediately after the interaction burst).',
        ),
      settled_handle: z
        .string()
        .optional()
        .describe(
          'Handle of the snapshot taken after the app went idle and GC ran.',
        ),
      baseline_handle: z
        .string()
        .optional()
        .describe(
          'Optional handle of a pre-activity baseline. With it, each class is scored on how much of its GROWTH came back; without it, on how much of its total came back (a harsher and less meaningful test for classes with a large standing population).',
        ),
      limit: z
        .number()
        .optional()
        .default(25)
        .describe('Maximum classes to report (default 25).'),
      min_growth: z.number().optional().default(100),
      trace_held: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'For every class that SURVIVED idle + GC, sample its instances in the settled rung and group them by where their retainer path ENDS. A class whose instances all share one root head has one root cause and one fix; a class spread across several has several. This was done by hand on two populations in one sweep and was decisive both times (14/14 on one path). Costs one extra FULL load of the settled rung — the histogram passes are light and carry no path edges — which is why it is opt-in. Only meaningful with a baseline, i.e. via `run_dir`.',
        ),
      trace_sample: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(40)
        .describe(
          'Instances per held class to trace when `trace_held` is set (default 40).',
        ),
    },
    async ({
      run_dir,
      busy_handle,
      settled_handle,
      baseline_handle,
      limit,
      min_growth,
      trace_held,
      trace_sample,
    }) => {
      try {
        // run_dir is the ergonomic path: the runner already knows which rung is
        // the last driven one and which is the settle rung, so re-deriving that
        // by hand (and loading both with keep_previous) is pure ceremony that
        // an operator skips — and skipping the settle comparison is exactly how
        // a backlog gets published as a leak.
        // Only the per-class histograms are compared, so the run_dir path can
        // load each rung transiently and drop it. That matters: holding two
        // multi-gigabyte graphs resident is what forces an operator to raise
        // the old-space limit, and it is the reason this comparison was being
        // skipped in practice.
        let busyHist: Map<string, ClassStats>;
        let settledHist: Map<string, ClassStats>;
        let baseHist: Map<string, ClassStats> | null = null;
        let source: string;
        // Only the `run_dir` path knows a FILE for the settled rung, and the
        // trace needs to re-open it with path edges. A handle-based call
        // therefore cannot trace, and says so rather than tracing the wrong
        // graph.
        let settledPathForTrace: string | null = null;

        if (run_dir != null) {
          const pair = resolveSettlePair(run_dir);
          if (typeof pair === 'string') {
            return errorResult(new Error(pair));
          }
          busyHist = await withSnapshotAt(
            pair.busyPath,
            async (snap: IHeapSnapshot) => histogram(snap),
          );
          settledHist = await withSnapshotAt(
            pair.settledPath,
            async (snap: IHeapSnapshot) => histogram(snap),
          );
          if (pair.baselinePath != null) {
            baseHist = await withSnapshotAt(
              pair.baselinePath,
              async (snap: IHeapSnapshot) => histogram(snap),
            );
          }
          settledPathForTrace = pair.settledPath;
          source =
            `run_dir ${run_dir}\n` +
            `busy   : ${path.basename(pair.busyPath)}\n` +
            `settled: ${path.basename(pair.settledPath)}` +
            (pair.baselinePath != null
              ? `\nbaseline: ${path.basename(pair.baselinePath)}`
              : '');
        } else {
          if (busy_handle == null || settled_handle == null) {
            return errorResult(
              new Error(
                'Pass either run_dir (recommended — it resolves the rungs for you), ' +
                  'or both busy_handle and settled_handle.',
              ),
            );
          }
          const busy = getSnapshotByHandle(busy_handle);
          const settled = getSnapshotByHandle(settled_handle);
          if (busy == null || settled == null) {
            const missing = [
              busy == null ? busy_handle : null,
              settled == null ? settled_handle : null,
            ].filter(Boolean);
            return errorResult(
              new Error(
                `Not resident: ${missing.join(', ')}. Load every rung with memlab_load_snapshot({keep_previous: true}), or pass run_dir and let this tool load them transiently.`,
              ),
            );
          }
          const baseline =
            baseline_handle != null
              ? getSnapshotByHandle(baseline_handle)
              : null;
          if (baseline_handle != null && baseline == null) {
            return errorResult(new Error(`Not resident: ${baseline_handle}.`));
          }
          busyHist = histogram(busy);
          settledHist = histogram(settled);
          baseHist = baseline != null ? histogram(baseline) : null;
          source = `handles ${busy_handle} -> ${settled_handle}`;
        }

        const rows: Array<{
          key: string;
          base: number;
          busy: number;
          idle: number;
          verdict: Verdict;
          reclaimed: number;
        }> = [];

        for (const [key, busyStats] of busyHist) {
          const base = baseHist?.get(key)?.count ?? 0;
          const idle = settledHist.get(key)?.count ?? 0;
          const grew = busyStats.count - base;
          if (grew < min_growth) continue;
          rows.push({
            key,
            base,
            busy: busyStats.count,
            idle,
            verdict: classify(base, busyStats.count, idle),
            reclaimed: busyStats.count - idle,
          });
        }

        // Whether a baseline EXISTS, not whether the caller named one by
        // handle. `run_dir` resolves and loads a baseline rung itself, so
        // keying the verdict on `baseline_handle` threw away a 1.1 GB load
        // and reported the weaker "ranks reclamation, not leaks" wording on
        // the path that actually had the stronger evidence.
        const hasBaseline = baseHist != null;
        const baselineLabel = baseline_handle ?? "the run dir's baseline rung";

        if (rows.length === 0) {
          return toolResult(
            `No class grew by at least ${formatNumber(min_growth)} between ${hasBaseline ? baselineLabel : '(no baseline)'} and ${busy_handle ?? 'the last driven rung'}. Lower min_growth, or check that the rungs are in the right order (busy, then settled).`,
          );
        }

        rows.sort((a, b) => b.busy - b.idle - (a.busy - a.idle));
        const held = rows.filter(
          r => r.verdict === 'held' || r.verdict === 'still-growing',
        );
        const drained = rows.filter(r => r.verdict === 'drained');

        const busyTotal = totalSelfSize(busyHist);
        const settledTotal = totalSelfSize(settledHist);

        const lines: string[] = [
          '## Settle check',
          '',
          source,
          `Heap self size ${formatBytes(busyTotal)} → ${formatBytes(settledTotal)} (${settledTotal <= busyTotal ? '−' : '+'}${formatBytes(Math.abs(busyTotal - settledTotal))} reclaimed by settling).`,
          '',
          !hasBaseline
            ? `**No baseline given, so this ranks reclamation, not leaks.** ${drained.length} class(es) came back almost entirely (in-flight work) and ${held.length} stayed — but "stayed" here includes every large standing population that was never part of the burst, because without a pre-activity rung there is no growth to measure the reclamation against. Supply one to turn this into a leak verdict: pass \`baseline_handle\`, or use a \`run_dir\` whose round has more than one driven rung (the first is taken as the baseline).`
            : held.length === 0
              ? '**Everything that grew came back.** No class survived idle + GC, so the growth in this round was in-flight work, not retention. There is nothing here to fix.'
              : `**${held.length} class(es) survived idle + GC** and ${drained.length} drained. Only the survivors are leak candidates — the drained ones were backlog and should not be reported as findings.`,
          '',
        ];

        const headers = hasBaseline
          ? ['Class', 'baseline', 'busy', 'settled', 'reclaimed', 'Verdict']
          : ['Class', 'busy', 'settled', 'reclaimed', 'Verdict'];
        const rightCols = hasBaseline
          ? new Set([1, 2, 3, 4])
          : new Set([1, 2, 3]);
        const tableRows = rows.slice(0, limit).map(r => {
          const {type, name} = splitClassKey(r.key);
          const label = `${name} (${type})`;
          const cells = hasBaseline
            ? [
                label,
                formatNumber(r.base),
                formatNumber(r.busy),
                formatNumber(r.idle),
                formatNumber(r.reclaimed),
              ]
            : [
                label,
                formatNumber(r.busy),
                formatNumber(r.idle),
                formatNumber(r.reclaimed),
              ];
          const note = hasBaseline
            ? VERDICT_NOTE[r.verdict]
            : VERDICT_NOTE_NO_BASELINE[r.verdict];
          return [...cells, `${r.verdict} — ${note}`];
        });
        lines.push(markdownTable(headers, tableRows, rightCols));

        if (rows.length > limit) {
          lines.push('', `_… and ${rows.length - limit} more; raise limit._`);
        }
        lines.push(
          '',
          '_A "drained" verdict is only as good as the settle: if the capture was taken before timers, network callbacks and storage writes finished, work still in flight will read as retention. Give it 30-60s of true idle and force GC first._',
        );
        if (trace_held && held.length > 0 && settledPathForTrace != null) {
          // Only the classes that will be RENDERED. The trace is the
          // expensive half of an already-expensive extra full load — id
          // collection plus per-class sampling — and computing it for held
          // classes past `limit` produced results the table then discarded.
          const tracedKeys = held.slice(0, limit).map(r => r.key);
          // Isolated. `trace_held` is an OPT-IN extra — a second full load of
          // the settled rung, with path edges, which is the heaviest thing
          // this tool can be asked to do and the likeliest to run out of
          // memory. The HELD/DRAINED verdict above it is already computed and
          // is the answer the caller came for; losing it to a failure in an
          // add-on turns a slow success into a total one.
          // `null` rather than an early return. Returning here skipped the
          // "Next" guidance at the end of the tool — so the one output that
          // most needs a next step, the one whose trace just failed, was the
          // only one that did not get one.
          let heads: Map<string, Array<{head: string; count: number}>> | null =
            null;
          try {
            heads = await traceHeldClasses(
              settledPathForTrace,
              tracedKeys,
              trace_sample,
            );
          } catch (e) {
            lines.push(
              '',
              `> ⚠️ **\`trace_held\` failed** (${e instanceof Error ? e.message : String(e)}). It re-opens the settled rung with path edges, which is a second full load; the HELD/DRAINED verdict above did not need it and stands. Retry with a lower \`limit\`, or trace one class with \`memlab_retainer_trace\`.`,
            );
          }
          if (heads != null) {
            lines.push('', '### Where the survivors are rooted', '');
            lines.push(
              markdownTable(
                [
                  'Class',
                  'Sampled',
                  'Dominant retainer path',
                  'Share',
                  'Distinct paths',
                ],
                held.slice(0, limit).map(r => {
                  const rows = heads.get(r.key) ?? [];
                  const total = rows.reduce((sum, h) => sum + h.count, 0);
                  const top = rows[0];
                  const {name} = splitClassKey(r.key);
                  return [
                    clampLabel(name, 44),
                    formatNumber(total),
                    top == null ? '—' : top.head,
                    top == null || total === 0
                      ? '—'
                      : `${((top.count / total) * 100).toFixed(0)}%`,
                    formatNumber(rows.length),
                  ];
                }),
                new Set([1, 3, 4]),
              ),
            );
            lines.push(
              '',
              '_One distinct path at 100% means ONE root cause and one fix. Several mean several — and a fix ' +
                'that closes the largest leaves the rest retaining the population. Each path is the nearest three ' +
                'NAMED hops, root-ward first; the literal top of a path is always `(GC roots)` and groups nothing. ' +
                'A class with 0 sampled has no traceable instance in the settled rung._',
            );
          }
        }
        if (held.length > 0 && hasBaseline) {
          lines.push(
            '',
            trace_held
              ? '**Next:** `memlab_retainer_trace` on an example instance behind the dominant head above — that is the trace worth putting in a fix.'
              : '**Next:** for each survivor, `memlab_retainer_trace` on an example instance in the settled snapshot — that is the trace worth putting in a fix. `trace_held: true` groups every survivor by root-path head in one call instead.',
          );
        }
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

function totalSelfSize(hist: Map<string, ClassStats>): number {
  let total = 0;
  for (const s of hist.values()) total += s.selfSize;
  return total;
}
