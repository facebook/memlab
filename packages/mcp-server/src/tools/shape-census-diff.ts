/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * Per-SHAPE growth across a ladder.
 *
 * `memlab_census_diff` is per CLASS, and on a data-heavy app the class is
 * `Object`. "`Object` grew by 377,959, top retainer `Map.table`" is true and
 * useless; it sent one investigation chasing React hooks for three tool calls.
 * The same ladder, grouped by property set, answers it in one look:
 *
 *     {event,timestamp}                                    ~0 -> 53,029
 *     {data,timestamp,type}                                ~0 -> 31,299
 *     {priority,queueSize,type}                            ~0 -> 17,615
 *     {annotationKey,annotationValue,instanceKey,markerId}  ~0 -> 13,715
 *     {bottom,left,right,top}                              ~0 -> 12,822
 *
 * — the growth is telemetry records. `memlab_shape_histogram` already computes
 * a shape census, but for ONE snapshot; the diff across the ladder was
 * hand-rolled (dump rung 0, dump rung N, diff by hand) on every interesting
 * round of a 20-round sweep, ~8 calls each time.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  pathsHeader,
  toolResult,
} from '../utils.js';
import {
  describeCycleAxis,
  describeSegmentSelection,
  isSettleRungFilename,
  resolveLadderInputs,
  SEGMENT_ARG_DESCRIPTION,
} from '../run-manifest.js';
import {resolveRungs, withSnapshotAt} from '../snapshot-borrow.js';
import {linearFit} from './ladder-probe.js';
import {ensureSidecar, readSidecar, joinShapeKey} from '../snapshot-index.js';
import {normalizeClassName} from './sequence-analysis.js';
import {makeNamePatternTest} from '../utils.js';

interface ShapeStats {
  count: number;
  selfSize: number;
  exampleNodeId: number;
}

/**
 * The sorted property set of one object, as a stable key PLUS its real size.
 *
 * The count is returned rather than re-derived by splitting the key: a
 * property name can contain a comma, and `key.
 *
 * `unreadable` counts nodes whose reference list could not be walked.split(',').length` then
 * overcounts and drops the shape below a `max_props` filter.
 A
 * census is a COUNT, so a node dropped here is subtracted from a growth
 * figure with no trace — and if the same nodes fail on one rung and not
 * another, the difference reads as the app releasing them.
 */
function shapeKeyOf(
  node: IHeapNode,
  unreadable: {n: number},
): {key: string; propCount: number} | null {
  const names: string[] = [];
  try {
    for (const edge of node.references) {
      if (edge.type !== 'property') continue;
      const n = String(edge.name_or_index);
      if (n === '__proto__') continue;
      names.push(n);
    }
  } catch {
    unreadable.n++;
    return null;
  }
  if (names.length === 0) return null;
  names.sort();
  return {key: joinShapeKey(names), propCount: names.length};
}

function shapeCensus(
  snapshot: IHeapSnapshot,
  opts: {className?: string; namePattern?: string; maxProps: number},
): {shapes: Map<string, ShapeStats>; unreadable: number} {
  const nameMatches = makeNamePatternTest(opts.namePattern);
  const out = new Map<string, ShapeStats>();
  const unreadable = {n: 0};
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.type !== 'object') return;
    if (node.id <= 3) return;
    if (opts.className != null && node.name !== opts.className) return;
    if (nameMatches != null && !nameMatches(node.name)) return;
    const shape = shapeKeyOf(node, unreadable);
    if (shape == null) return;
    const {key, propCount} = shape;
    // A shape with hundreds of keys is a namespace object or a module map,
    // not a record type, and its key alone would dominate the table. Counted
    // from the property LIST, not by splitting the joined key: a property
    // name containing a comma would otherwise inflate the count.
    if (propCount > opts.maxProps) return;
    const e = out.get(key);
    if (e) {
      e.count++;
      e.selfSize += node.self_size;
    } else {
      out.set(key, {
        count: 1,
        selfSize: node.self_size,
        exampleNodeId: node.id,
      });
    }
  });
  return {shapes: out, unreadable: unreadable.n};
}

/** `a,b,c` -> `{a,b,c}`, clipped so one wide shape cannot set the table width. */
function renderShape(key: string, maxLen: number): string {
  const full = `{${key.split(',').join(',')}}`;
  return full.length <= maxLen ? full : `${full.slice(0, maxLen - 1)}…}`;
}

export function registerShapeCensusDiff(server: McpServer): void {
  server.tool(
    'memlab_shape_census_diff',
    'Per-SHAPE growth across a LADDER: group objects by their property set at every rung and report the series, the per-cycle rate and the fit — the shape-level equivalent of `memlab_leak_report`.\n\n' +
      'Use this the moment a class-level tool blames `Object`. On a data-heavy app most of the heap IS `Object`, so "`Object` grew by 377,959, retainer `Map.table`" names nothing; the same ladder grouped by shape reads `{event,timestamp} ~0 -> 53,029`, `{data,timestamp,type} ~0 -> 31,299`, `{bottom,left,right,top} ~0 -> 12,822` — i.e. "the growth is telemetry records and DOMRects" — in one call. ' +
      '`memlab_shape_histogram` answers this for ONE snapshot; `memlab_census_diff` answers it across a ladder but per CLASS. This is the missing cell.\n\n' +
      'With `include_settle` (default on when the round captured a settle rung) each shape also gets its post-idle count and a drained/held verdict, so in-flight backlog is separated from retention in the same table. Pass `class_filter: "Object"` to look only at plain objects, which is usually what you want. Rungs are loaded one at a time and dropped, so a long ladder costs wall clock rather than memory.',
    {
      run_dir: z
        .string()
        .optional()
        .describe(
          "A leak-hunt round's output directory (the one holding run.json and snapshots/). PREFERRED over `paths`: the rung paths, the exact per-rung cycle counts and the settle rung are all read from run.json.",
        ),
      segment: z
        .union([z.number(), z.literal('all')])
        .optional()
        .describe(SEGMENT_ARG_DESCRIPTION),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Ordered snapshot paths, oldest first. Only needed without `run_dir`.',
        ),
      cycles_per_rung: z
        .array(z.number())
        .optional()
        .describe(
          'Exact cumulative cycle count at each rung. Must match `paths` in length. Without it (and without `run_dir`) the rate is per rung, not per cycle.',
        ),
      class_filter: z
        .string()
        .optional()
        .describe(
          'Only group objects whose constructor name is exactly this — `"Object"` is the usual choice, and the case this tool exists for.',
        ),
      name_pattern: z
        .string()
        .optional()
        .describe(
          'Only group objects whose constructor name matches this case-insensitive regex (plain substring when it is not valid regex). Applied before shape grouping.',
        ),
      top: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(30)
        .describe(
          'Maximum shapes to report, ranked by net growth (default 30).',
        ),
      min_growth: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(50)
        .describe(
          'Only report shapes whose net instance growth across the ladder is at least this (default 50).',
        ),
      max_props: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(24)
        .describe(
          'Ignore objects with more properties than this (default 24). A 300-key object is a namespace or a module map, not a record type, and its shape key alone would set the table width.',
        ),
      include_settle: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'When `run_dir` names a round with a settle rung, census it too and report a post-idle count and a drained/held verdict per shape. This is what stops a burst of in-flight records being reported as a leak; it is excluded from the rate fit, since the settle drives no cycles.',
        ),
      max_file_size_mb: z
        .number()
        .optional()
        .describe('Per-file size ceiling, matching memlab_load_snapshot.'),
    },
    async ({
      run_dir,
      segment,
      paths,
      cycles_per_rung,
      class_filter,
      name_pattern,
      top,
      min_growth,
      max_props,
      include_settle,
      max_file_size_mb,
    }) => {
      try {
        const inputs = resolveLadderInputs({
          run_dir,
          segment,
          paths,
          cycles_per_rung,
        });
        const axis = inputs.cyclesPerRung;
        const {rungs} = resolveRungs(inputs.paths, max_file_size_mb);
        if (rungs.length < 2) {
          return errorResult(
            new Error(
              `memlab_shape_census_diff needs at least 2 rungs; got ${rungs.length}. A trend needs two points.`,
            ),
          );
        }

        const censusOpts = {
          className: class_filter,
          namePattern: name_pattern,
          maxProps: max_props,
        };
        /**
         * The shape census for one rung, from the sidecar when it can be.
         *
         * The sidecar's shape table is UNFILTERED (it is built once, before
         * anyone knows what will be asked), so it only answers a call with no
         * class/name filter — but that is the common call, and it turns a
         * 22-43 s parse per rung into a JSON read. With a filter, the graph is
         * opened as before.
         */
        const censusOf = async (
          localPath: string,
          opts: typeof censusOpts,
        ): Promise<Map<string, ShapeStats>> => {
          const unfiltered = opts.className == null && opts.namePattern == null;
          if (unfiltered) {
            const side = readSidecar(localPath);
            if (side != null) {
              cachedRungs++;
              // The count the sidecar RECORDED when it was built, so a
              // cached rung reports the same short-walk caveat a freshly
              // parsed one does instead of looking cleaner for having
              // skipped the walk.
              unreadableNodes += side.unreadableNodes ?? 0;
              const out = new Map<string, ShapeStats>();
              for (const [key, entry] of Object.entries(side.shapes)) {
                const [count, selfSize, propCount] = entry;
                // The STORED property count, with no fallback. A property
                // name containing a comma makes `key.split(',').length` too
                // high and drops a shape the fresh census keeps, so falling
                // back to it would apply a different rule to exactly the
                // shapes the stored count exists for. `readSidecar` rejects
                // a sidecar whose tuples are not all three numbers, so this
                // is a number.
                if (propCount > opts.maxProps) continue;
                out.set(key, {count, selfSize, exampleNodeId: 0});
              }
              return out;
            }
          }
          return withSnapshotAt(localPath, snap => {
            // Built while the graph is open anyway, so the NEXT tool over this
            // rung pays neither a parse nor a census.
            ensureSidecar(snap, localPath, normalizeClassName);
            const r = shapeCensus(snap, opts);
            unreadableNodes += r.unreadable;
            return r.shapes;
          });
        };
        // One rung resident at a time. A shape census is a single O(N) pass
        // and holds only the per-shape counters, so a 6-rung ladder of
        // 500 MB captures costs wall clock and not memory.
        const perRung: Array<Map<string, ShapeStats>> = [];
        let unreadableNodes = 0;
        let settleUnreadable = 0;
        /** Shapes the settle census never mentioned — unknown, not zero. */
        let absentFromSettle = 0;
        let cachedRungs = 0;
        for (const rung of rungs) {
          perRung.push(await censusOf(rung.localPath, censusOpts));
        }

        const settlePath =
          include_settle !== false
            ? (inputs.manifest?.settleRungPath ?? null)
            : null;
        let settled: Map<string, ShapeStats> | null = null;
        let settleError: string | null = null;
        if (settlePath != null) {
          try {
            const {rungs: settleRungs} = resolveRungs(
              [settlePath],
              max_file_size_mb,
            );
            // One path in, so one rung out or a throw — but the settle rung
            // is the last captured and usually the largest, which makes the
            // size ceiling the likeliest thing to stop it. Say so rather than
            // letting an empty list surface as a TypeError in a column
            // labelled "Settled".
            if (settleRungs.length === 0) {
              throw new Error('the settle rung could not be resolved');
            }
            // Attributed to the settle rung, not folded into the ladder
            // total. The ladder warning reasons about rungs DISAGREEING with
            // each other, and the settle rung is not one of them.
            //
            // Restored in a `finally`. `censusOf` can throw part-way through
            // a walk that has already incremented the shared counter, and a
            // plain sequence leaves that increment on the LADDER total —
            // where it is reported as rungs disagreeing with each other,
            // which is a different and wrong claim about a failure that
            // happened in the settle rung.
            const ladderUnreadable = unreadableNodes;
            try {
              settled = await censusOf(settleRungs[0].localPath, censusOpts);
            } finally {
              settleUnreadable = unreadableNodes - ladderUnreadable;
              unreadableNodes = ladderUnreadable;
            }
          } catch (e) {
            settleError = e instanceof Error ? e.message : String(e);
          }
        }

        const keys = new Set<string>();
        for (const m of perRung) for (const k of m.keys()) keys.add(k);

        interface Row {
          key: string;
          counts: number[];
          net: number;
          netSize: number;
          idle: number | null;
          kept: number | null;
          slope: number;
          r2: number;
          example: number;
        }
        // The axis has to COVER the ladder. A short or gappy `cycles_per_rung`
        // silently substituted the rung index for the missing entries while
        // the column still said "Δ/cycle" — a slope fitted against two
        // different units, labelled as one of them.
        const axisCovers =
          axis != null &&
          axis.length >= rungs.length &&
          rungs.every((_, i) => typeof axis[i] === 'number');
        const xs = rungs.map((_, i) => (axisCovers ? axis[i] : i));
        const perCycle = axisCovers;
        const rows: Row[] = [];
        for (const key of keys) {
          const counts = perRung.map(m => m.get(key)?.count ?? 0);
          const net = counts[counts.length - 1] - counts[0];
          if (net < min_growth) continue;
          const fit = linearFit(xs, counts);
          // A shape ABSENT from the settle census is not a shape measured at
          // zero. `?? 0` made the two identical, so a held shape the settle
          // pass never saw was labelled "drained" — hiding a leak in the
          // HELD/DRAINED headline rather than merely mis-rendering a cell.
          // Absence is scored as unknown; `kept == null` already renders as
          // no verdict, and the count below says how often it happened.
          const settledEntry = settled != null ? settled.get(key) : undefined;
          const idle =
            settled == null || settledEntry == null ? null : settledEntry.count;
          if (settled != null && settledEntry == null) absentFromSettle++;
          rows.push({
            key,
            counts,
            net,
            netSize:
              (perRung[perRung.length - 1].get(key)?.selfSize ?? 0) -
              (perRung[0].get(key)?.selfSize ?? 0),
            idle,
            // Guarded AND clamped. `net` is positive by the `min_growth`
            // filter above, but a guard here is what makes that a local fact
            // rather than an invariant two hundred lines away; and the raw
            // ratio is unbounded in both directions, so an idle count above
            // the growth would print "400% held" and one below the baseline
            // a negative.
            kept:
              idle == null || net <= 0
                ? null
                : Math.max(0, Math.min(1, (idle - counts[0]) / net)),
            slope: fit.slope,
            r2: fit.r2,
            example:
              perRung[perRung.length - 1].get(key)?.exampleNodeId ??
              perRung[0].get(key)?.exampleNodeId ??
              0,
          });
        }
        rows.sort((a, b) => b.net - a.net);

        const lines: string[] = [
          `## Shape census diff — ${rungs.length} rungs${
            class_filter != null ? `, class \`${class_filter}\`` : ''
          }`,
          '',
        ];
        lines.push(describeCycleAxis(inputs.source, axis));
        const segmentNote = describeSegmentSelection(
          inputs.segment,
          inputs.manifest,
        );
        if (segmentNote != null) lines.push(segmentNote);
        lines.push('');

        if (rows.length === 0) {
          lines.push(
            `No object shape grew by at least ${formatNumber(min_growth)} instances across the ladder. ` +
              (class_filter != null || name_pattern != null
                ? 'The filter may be too narrow — re-run without `class_filter`/`name_pattern` to see every shape.'
                : 'Lower `min_growth`, or the growth is not in plain objects (try `memlab_leak_report` for a per-class view).'),
          );
          return toolResult(
            lines.join('\n'),
            pathsHeader(rungs.map(r => r.label)),
          );
        }

        const DRAIN_THRESHOLD = 0.1;
        const isDrained = (r: Row) =>
          r.kept != null && r.kept <= DRAIN_THRESHOLD && r.net > 0;
        // Tallied over EVERY row over the threshold, not just the `top` that
        // fit in the table. The headline is read as the round's verdict, and
        // counting only the displayed rows makes it shrink as `top` shrinks —
        // the same round reporting a different settle result depending on how
        // much of it was printed.
        let drainedShapes = 0;
        let heldShapes = 0;
        for (const r of rows) {
          if (r.kept == null) continue;
          if (isDrained(r)) drainedShapes++;
          else heldShapes++;
        }
        const shown = rows.slice(0, top);
        const headers = [
          'Shape',
          ...rungs.map((r, i) =>
            isSettleRungFilename(r.label) ? 'settle' : `#${i + 1}`,
          ),
          'Δ',
          ...(settled != null ? ['after settle'] : []),
          perCycle ? 'Δ/cycle' : 'Δ/rung',
          'r²',
          'Δ self size',
          'example',
        ];
        const tableRows = shown.map(r => {
          const drained = isDrained(r);
          return [
            renderShape(r.key, 52),
            ...r.counts.map(c => formatNumber(c)),
            `+${formatNumber(r.net)}`,
            ...(settled != null
              ? [
                  r.idle == null || r.kept == null
                    ? '— (absent)'
                    : `${formatNumber(r.idle)} (${
                        drained
                          ? 'drained'
                          : `${(r.kept * 100).toFixed(0)}% held`
                      })`,
                ]
              : []),
            `${r.slope >= 0 ? '+' : ''}${r.slope.toFixed(2)}`,
            r.r2.toFixed(4),
            `${r.netSize >= 0 ? '+' : ''}${formatBytes(r.netSize)}`,
            r.example > 0 ? `@${r.example}` : '—',
          ];
        });
        const rightCols = new Set<number>();
        for (let i = 1; i < headers.length - 1; i++) rightCols.add(i);
        lines.push(markdownTable(headers, tableRows, rightCols));

        if (cachedRungs > 0) {
          lines.push(
            '',
            `_${cachedRungs} rung(s) answered from a sidecar index without opening the graph. A cached rung carries no \`example\` node id (ids are per-capture and the sidecar does not keep one) — re-run with \`class_filter\` or \`MEMLAB_NO_INDEX_CACHE=1\` to get one._`,
          );
        }

        if (rows.length > shown.length) {
          lines.push(
            '',
            `_… and ${formatNumber(rows.length - shown.length)} more shape(s) over the growth threshold; raise \`top\`._`,
          );
        }

        if (settled != null) {
          lines.push(
            '',
            `**Settle: ${formatNumber(heldShapes)} shape(s) HELD / ${formatNumber(drainedShapes)} DRAINED.** ` +
              'A DRAINED shape came back after idle + GC — it was in-flight work, not retention. Only the HELD rows are leak candidates.',
          );
        } else if (settleError != null) {
          lines.push(
            '',
            `> ⚠️ The round names a settle rung but it could not be read (${settleError}), so nothing here separates retention from backlog.`,
          );
        } else if (include_settle !== false && inputs.manifest != null) {
          lines.push(
            '',
            '> ⚠️ **UNSETTLED** — this round captured no settle rung, so a shape that is pure in-flight backlog is indistinguishable here from one that leaks.',
          );
        }

        if (absentFromSettle > 0) {
          lines.push(
            '',
            `> ⚠️ ${formatNumber(absentFromSettle)} shape(s) above appear nowhere in the settle census, so their "after settle" is UNKNOWN rather than zero and they are neither HELD nor DRAINED. ` +
              'One or two is ordinary — the shape genuinely went to zero and carries no example node. Most of them means the settle rung is short, and then the whole column is describing the file rather than the app.',
          );
        }
        if (settleUnreadable > 0) {
          lines.push(
            '',
            `> ⚠️ ${formatNumber(settleUnreadable)} object(s) in the SETTLE rung had an unreadable reference list, so the "after settle" column is short by that much — ` +
              'a shape can read as drained because its instances could not be counted there.',
          );
        }
        if (unreadableNodes > 0) {
          lines.push(
            '',
            `> ⚠️ ${formatNumber(unreadableNodes)} object(s) across the ladder had an unreadable reference list and carry no shape here. ` +
              'A census is a count, so those are missing from the figures above — and if a rung failed on more of them than its neighbour, ' +
              'the difference reads as growth or as a release that did not happen.',
          );
        }
        if (axis != null && !axisCovers) {
          lines.push(
            '',
            `> ⚠️ The cycle axis covers ${formatNumber(axis.length)} of ${formatNumber(rungs.length)} rungs, so the rate above is per RUNG, not per cycle. ` +
              'Pass a `cycles_per_rung` with one entry per rung to get a per-cycle rate.',
          );
        }

        lines.push(
          '',
          '_A shape is a property SET, not a type: two unrelated record types with the same keys collapse into one row. ' +
            'Take the `example` node id to `memlab_retainer_trace` / `memlab_identify` to name the thing before reporting it._',
          '',
          '_A field holding a small INTEGER emits no property edge in a V8 snapshot, so it is not part of the shape here: ' +
            '`{id: 7, name: "x"}` reads as `{name}`, and a record whose fields are all integers has no shape at all and is absent from this table._',
        );
        return toolResult(
          lines.join('\n'),
          pathsHeader(rungs.map(r => r.label)),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
