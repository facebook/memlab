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
import {z} from 'zod';
import {
  DEFAULT_MIN_REGISTRY_EVENTS,
  registryEvents,
} from '../emitter-shapes.js';
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {getSnapshot} from '../heap-state.js';
import {ladderShape} from '../ladder-shape.js';
import {
  describeSegmentSelection,
  resolveLadderInputs,
  segmentArg,
} from '../run-manifest.js';
import {
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
  withSnapshotAt,
} from '../snapshot-borrow.js';
import {
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
  makeScanBudget,
  ScanTimeoutError,
} from '../utils.js';

const GROUP_KEYS = ['event', 'callback', 'emitter', 'context'] as const;
type GroupKey = (typeof GROUP_KEYS)[number];
const DEFAULT_GROUP: GroupKey[] = ['event', 'callback'];
const GROUP_LABELS: Record<GroupKey, string> = {
  event: 'Event',
  callback: 'Callback',
  emitter: 'Emitter',
  context: 'Context class',
};

/**
 * The emitter a registry container belongs to, as `<owner class>.<property>`
 * (`_class.$Events$p_eventMap`): the container itself is a plain Object.
 */
function emitterOf(container: IHeapNode): string {
  for (const e of container.referrers) {
    if (e.type === 'property') {
      return `${e.fromNode.name}.${String(e.name_or_index)}`;
    }
  }
  return container.name;
}

/** The listener's context node, or null for none / `undefined` / `null`. */
function realContext(snap: IHeapSnapshot, contextId: number): IHeapNode | null {
  const ctx = contextId === 0 ? null : snap.getNodeById(contextId);
  return ctx == null || ctx.name === 'undefined' || ctx.name === 'null'
    ? null
    : ctx;
}

/** One listener's group key; `\u0000` joins the parts. */
function groupKeyOf(
  snap: IHeapSnapshot,
  groupBy: GroupKey[],
  event: string,
  emitter: string,
  callbackId: number,
  contextId: number,
): string {
  return groupBy
    .map(k => {
      if (k === 'event') return event;
      if (k === 'emitter') return emitter;
      if (k === 'callback') {
        return snap.getNodeById(callbackId)?.name || '(anonymous)';
      }
      return realContext(snap, contextId)?.name ?? '(no context)';
    })
    .join('\u0000');
}

function isDefaultGroup(groupBy: GroupKey[]): boolean {
  return groupBy.join() === DEFAULT_GROUP.join();
}

function groupHeader(groupBy: GroupKey[]): string {
  return isDefaultGroup(groupBy)
    ? 'Event → callback'
    : groupBy.map(k => GROUP_LABELS[k]).join(' · ');
}

function renderKey(key: string, groupBy: GroupKey[]): string {
  const text = key
    .split('\u0000')
    .join(isDefaultGroup(groupBy) ? ' → ' : ' · ');
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

/**
 * Listener records per group (default `event -> callback`) in one snapshot,
 * from every object with >= `minEvents` event-name -> listener-array
 * properties.
 *
 * Counted by callback NAME, not by closure: one callback closure bound by 246
 * records is ONE closure node, so `iterByClass(callbackName)` returned 1 while
 * the records — the thing that grows — numbered 246.
 */
function listenerRecordsByGroup(
  snap: IHeapSnapshot,
  minEvents: number,
  groupBy: GroupKey[],
): Map<string, number> {
  const out = new Map<string, number>();
  let skipped = 0;
  // Nodes holding at least one Array property: the ones a broken listener
  // read would throw on, so the denominator for "most of the rung failed".
  let candidates = 0;
  snap.nodes.forEach(node => {
    if (node.id <= 3 || node.type !== 'object') return;
    // Per node: a throw on one malformed node or edge must not discard every
    // count already taken, which would blank the whole rung's column.
    try {
      const hasArray = node.references.some(
        edge =>
          edge.type === 'property' &&
          edge.toNode.type === 'object' &&
          edge.toNode.name === 'Array',
      );
      if (!hasArray) return;
      candidates++;
      const local = registryEvents(node, minEvents);
      if (local == null) return;
      const counts: Array<[string, number]> = [];
      const emitter = groupBy.includes('emitter') ? emitterOf(node) : '';
      for (const {name: event, listeners} of local) {
        for (const l of listeners) {
          // The full event name: a 40-char prefix merged distinct events.
          counts.push([
            groupKeyOf(
              snap,
              groupBy,
              event,
              emitter,
              l.callbackId,
              l.contextId,
            ),
            1,
          ]);
        }
      }
      // Committed only once the node is fully read: a half-counted node
      // would bias the rung it was skipped from.
      for (const [key, n] of counts) out.set(key, (out.get(key) ?? 0) + n);
    } catch (e) {
      if (e instanceof ScanTimeoutError) throw e;
      skipped++;
    }
  });
  // Mostly skipped is a broken scan, not a small rung: fail it so the ladder
  // shows the rung as unreadable instead of as near-zero counts.
  if (skipped > 0 && skipped * 2 > candidates) {
    throw new Error(
      `${skipped} of ${candidates} listener-holding node(s) could not be read`,
    );
  }
  if (skipped > 0) {
    process.stderr.write(
      `[event_registry] skipped ${skipped} unreadable node(s) in one rung\n`,
    );
  }
  return out;
}

async function listenerLadder(args: {
  run_dir?: string;
  segment?: number | 'all';
  minEvents: number;
  limit: number;
  groupBy: GroupKey[];
}): Promise<ReturnType<typeof toolResult>> {
  const inputs = resolveLadderInputs({
    run_dir: args.run_dir,
    segment: args.segment,
  });
  const {rungs, largestMB} = resolveRungs(inputs.paths);
  const perRung: Array<Map<string, number> | null> = [];
  const failures: string[] = [];
  for (const rung of rungs) {
    armScanBudgetFor(scaledTimeoutMs(largestMB));
    try {
      perRung.push(
        await withSnapshotAt(rung.localPath, snap =>
          listenerRecordsByGroup(snap, args.minEvents, args.groupBy),
        ),
      );
    } catch (err) {
      perRung.push(null);
      failures.push(`${rung.label.replace(/^.*\//, '')}: ${String(err)}`);
    }
  }
  const read = perRung.filter((m): m is Map<string, number> => m != null);
  if (read.length < 2) {
    return errorResult(
      new Error(
        `only ${read.length} rung(s) could be read; a ladder needs 2.` +
          (failures.length > 0 ? ` ${failures.join('; ')}` : ''),
      ),
    );
  }
  const axis = inputs.cyclesPerRung;
  const shapeAxis =
    axis != null && axis.length === rungs.length ? axis : undefined;
  const keys = new Set<string>();
  for (const m of read) for (const k of m.keys()) keys.add(k);
  const rows = [...keys]
    .map(k => {
      const series = perRung.map(m => (m == null ? null : (m.get(k) ?? 0)));
      // Endpoints are the first and last rungs READ, for the delta and the
      // span alike, so an unreadable end rung does not skew the rate.
      const first = series.findIndex(v => v != null);
      let last = series.length - 1;
      while (last > first && series[last] == null) last--;
      const delta = (series[last] ?? 0) - (series[first] ?? 0);
      const span =
        shapeAxis != null && first >= 0
          ? shapeAxis[last] - shapeAxis[first]
          : null;
      const readVals = series.filter((v): v is number => v != null);
      const range = Math.max(...readVals) - Math.min(...readVals);
      return {k, series, delta, span, range};
    })
    // On the range, not the endpoints: a backlog that rose and drained back
    // has delta 0, and DRAINS is the verdict it exists to show.
    .filter(r => r.range !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.range - a.range);
  const segmentNote = describeSegmentSelection(inputs.segment, inputs.manifest);
  const lines = [
    `## Listener records by ${isDefaultGroup(args.groupBy) ? 'callback' : args.groupBy.map(k => GROUP_LABELS[k].toLowerCase()).join(' × ')}, across the ladder`,
    '',
    ...(segmentNote != null ? [segmentNote, ''] : []),
    `_${rungs.length} rungs; ${formatNumber(keys.size)} group(s), ${formatNumber(rows.length)} changed._`,
    '',
  ];
  if (rows.length === 0) {
    lines.push('_No listener population changed across the ladder._');
  } else {
    lines.push(
      markdownTable(
        [
          groupHeader(args.groupBy),
          ...rungs.map((_, i) => `#${i + 1}`),
          'Δ',
          'Δ/cycle',
          'Shape',
        ],
        rows
          .slice(0, args.limit)
          .map(r => [
            renderKey(r.k, args.groupBy),
            ...r.series.map(v => (v == null ? '—' : formatNumber(v))),
            `${r.delta >= 0 ? '+' : ''}${formatNumber(r.delta)}`,
            r.span != null && r.span > 0 ? (r.delta / r.span).toFixed(3) : '—',
            ladderShape(r.series, shapeAxis),
          ]),
        new Set(rungs.map((_, i) => i + 1)),
      ),
    );
  }
  if (failures.length > 0) {
    lines.push('', `_Unreadable rungs: ${failures.join('; ')}._`);
  }
  return toolResult(lines.join('\n'));
}

export function registerEventRegistry(server: McpServer): void {
  server.tool(
    'memlab_event_registry',
    'Detector for per-model event registries (Backbone/Marionette/observer style): objects mapping event names to arrays of {callback, context} listeners, e.g. `{"change:name": [{callback, context}], "add": [...]}`. Reports top event names by total listener count, the listeners-per-host distribution, and a structural-vs-leak verdict (one listener per host = O(hosts) structural baseline; the same callback instance bound to the same host/event more than once = a re-subscription leak). Complements memlab_event_listener_leaks by understanding the registry structure across many hosts.',
    {
      min_events: z
        .number()
        .optional()
        .default(DEFAULT_MIN_REGISTRY_EVENTS)
        .describe(
          'Minimum number of event-name->listener-array properties for an object to count as a registry container (default 2).',
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of event names to report (default 20).'),
      run_dir: z
        .string()
        .optional()
        .describe(
          "A leak-hunt round's output directory. Switches to LADDER mode: listener records per `event -> callback` at every rung, with Δ/cycle and a shape verdict (STEP / STEP+LINEAR / LINEAR / ONSET / SATURATING / DRAINS) per row.",
        ),
      segment: segmentArg(),
      group_by: z
        .array(z.enum(GROUP_KEYS))
        .min(1)
        .optional()
        .describe(
          'Group listener records by any of `event`, `callback`, `emitter` (owner class and property of the registry, e.g. `_class.$Events$p_eventMap`) and `context` (class of the listener\'s context object), e.g. `["emitter", "context", "callback"]` to ask whose records these are. Adds a table with distinct contexts per group; with `run_dir`, the ladder rows use this key (default `["event", "callback"]`).',
        ),
      timeout_ms: z
        .number()
        .optional()
        .default(45000)
        .describe(
          'Wall-clock scan budget (default 45000); returns partial results on very large browser heaps instead of hanging. Single-snapshot mode only: with `run_dir` each rung gets a budget scaled to its size.',
        ),
    },
    async ({min_events, limit, run_dir, segment, group_by, timeout_ms}) => {
      try {
        if (run_dir != null && run_dir !== '') {
          return await listenerLadder({
            run_dir,
            segment,
            minEvents: min_events,
            limit,
            groupBy: group_by ?? DEFAULT_GROUP,
          });
        }
        const snapshot = getSnapshot();
        const budget = makeScanBudget(timeout_ms);
        let timedOut = false;

        // Per event-name aggregates across ALL registry containers.
        const perEvent = new Map<
          string,
          {
            totalListeners: number;
            hosts: number;
            duplicatePairs: number; // same callback+context registered >1× on one host/event
          }
        >();
        let containerCount = 0;
        const perHostTotals: number[] = [];
        let totalListenersAll = 0;
        let totalDuplicateExtra = 0;
        const groups = new Map<
          string,
          {records: number; contexts: Set<number>; emitters: Set<number>}
        >();

        try {
          snapshot.nodes.forEach(node => {
            budget.tick();
            // A registry container has >= min_events properties whose target is
            // an Array of listeners.
            const localEvents = registryEvents(node, min_events);
            if (localEvents == null) return;
            const hostListeners = localEvents.reduce(
              (s, e) => s + e.listeners.length,
              0,
            );

            containerCount++;
            perHostTotals.push(hostListeners);
            totalListenersAll += hostListeners;
            if (group_by != null) {
              const emitter = group_by.includes('emitter')
                ? emitterOf(node)
                : '';
              for (const ev of localEvents) {
                for (const l of ev.listeners) {
                  const key = groupKeyOf(
                    snapshot,
                    group_by,
                    ev.name,
                    emitter,
                    l.callbackId,
                    l.contextId,
                  );
                  let g = groups.get(key);
                  if (g == null) {
                    g = {records: 0, contexts: new Set(), emitters: new Set()};
                    groups.set(key, g);
                  }
                  g.records++;
                  if (realContext(snapshot, l.contextId) != null) {
                    g.contexts.add(l.contextId);
                  }
                  g.emitters.add(node.id);
                }
              }
            }

            for (const ev of localEvents) {
              const e = perEvent.get(ev.name) ?? {
                totalListeners: 0,
                hosts: 0,
                duplicatePairs: 0,
              };
              e.totalListeners += ev.listeners.length;
              e.hosts++;
              // Duplicates WITHIN this host/event = same callback+context twice.
              const seen = new Map<string, number>();
              for (const l of ev.listeners) {
                const key = `${l.callbackId}\0${l.contextId}`;
                seen.set(key, (seen.get(key) ?? 0) + 1);
              }
              for (const c of seen.values()) {
                if (c > 1) {
                  e.duplicatePairs += c - 1;
                  totalDuplicateExtra += c - 1;
                }
              }
              perEvent.set(ev.name, e);
            }
          });
        } catch (e) {
          if (e instanceof ScanTimeoutError) timedOut = true;
          else throw e;
        }

        if (containerCount === 0) {
          return toolResult(
            `No per-model event registries found (objects with >= ${min_events} event-name -> listener-array properties).` +
              (timedOut ? ' (scan timed out before completing)' : '') +
              ' Try memlab_event_listener_leaks for _events/_listeners-style containers.',
          );
        }

        perHostTotals.sort((a, b) => a - b);
        const median = perHostTotals[Math.floor(perHostTotals.length / 2)];
        const maxPerHost = perHostTotals[perHostTotals.length - 1];
        const avgPerHost = totalListenersAll / containerCount;

        const topEvents = [...perEvent.entries()]
          .sort((a, b) => b[1].totalListeners - a[1].totalListeners)
          .slice(0, limit);

        // Structural vs leak. Duplicate (callback, context) pairs catch only
        // ONE leak shape: the same subscriber re-registering on the same host.
        // The other shape — many DISTINCT subscribers accumulating on one host,
        // each with its own context — produces zero duplicates and used to be
        // reported as "structural (not a leak)". That verdict is how a
        // 874k-listener accumulation reads as an O(hosts) baseline, so two more
        // signals are considered before calling anything structural.
        const dupRatio =
          totalListenersAll > 0 ? totalDuplicateExtra / totalListenersAll : 0;

        // (1) Distribution skew. A true one-listener-per-host baseline has mean
        // ~= median. A few hosts carrying thousands while the median carries a
        // handful is accumulation, whatever the callback identities look like.
        const skew = median > 0 ? avgPerHost / median : avgPerHost;
        const skewed = median > 0 && skew >= 3 && maxPerHost >= 50;

        // (2) Per-host concentration: any single host holding a large listener
        // array is worth flagging even when the fleet-wide mean looks sane.
        const concentrated = maxPerHost >= 100;

        let verdict: string;
        if (dupRatio >= 0.01) {
          verdict = `**⚠ Re-subscription leak:** ${formatNumber(totalDuplicateExtra)} duplicate registration(s) (${(dupRatio * 100).toFixed(1)}%) — the same callback instance is bound to the same host/event repeatedly (missing \`.off()\`/unsubscribe).`;
        } else if (skewed || concentrated) {
          const reasons: string[] = [];
          if (skewed) {
            reasons.push(
              `mean ${avgPerHost.toFixed(1)} vs median ${formatNumber(median)} listeners per host (${skew.toFixed(1)}× skew)`,
            );
          }
          if (concentrated) {
            reasons.push(
              `one host holds ${formatNumber(maxPerHost)} listeners`,
            );
          }
          verdict =
            `**⚠ Accumulation, not an O(hosts) baseline:** ${reasons.join('; ')}. ` +
            `Only ${formatNumber(totalDuplicateExtra)} duplicate (callback, context) pair(s) were found, so this is NOT the same-subscriber-twice shape — it is the other one: many DISTINCT subscribers piling up on the same emitter, each with its own context (typically short-lived views/collections that \`listenTo\` a long-lived model and never \`stopListening\`). ` +
            'Check the context objects: if they share a class and most are unreachable except through these registrations, they are stranded. ' +
            '`memlab_event_listener_leaks` (context distribution, orphan detection) and `memlab_retainer_trace` on one context will confirm.';
        } else if (totalDuplicateExtra === 0) {
          verdict =
            '**Structural, on the evidence checked:** every listener is a distinct callback/context, the per-host distribution is flat (mean ' +
            `${avgPerHost.toFixed(1)}, median ${formatNumber(median)}, max ${formatNumber(maxPerHost)}), and no host is disproportionately loaded — consistent with the expected O(hosts) baseline of one listener per model per event. ` +
            'This rules out re-subscription and per-host pile-up; it does NOT rule out the host population itself growing without bound, which needs a second rung (`memlab_sequence_analysis`).';
        } else {
          verdict = `**Mostly structural:** ${formatNumber(totalDuplicateExtra)} duplicate registration(s) (${(dupRatio * 100).toFixed(2)}%) — small re-subscription effect, likely benign. Per-host distribution is flat (mean ${avgPerHost.toFixed(1)}, median ${formatNumber(median)}).`;
        }

        const lines: string[] = [
          '## Event Registry Analysis',
          '',
          `${formatNumber(containerCount)} registry host(s), ${formatNumber(totalListenersAll)} total listeners.`,
          `Listeners per host: avg ${avgPerHost.toFixed(1)}, median ${formatNumber(median)}, max ${formatNumber(maxPerHost)}.`,
          '',
          verdict,
          '',
          '### Top event names by total listeners',
          '',
        ];
        const headers = ['Event', 'Total listeners', 'Hosts', 'Duplicates'];
        const rightCols = new Set([1, 2, 3]);
        const rows = topEvents.map(([name, e]) => [
          name.length > 40 ? name.slice(0, 37) + '…' : name,
          formatNumber(e.totalListeners),
          formatNumber(e.hosts),
          formatNumber(e.duplicatePairs),
        ]);
        lines.push(markdownTable(headers, rows, rightCols));
        if (group_by != null && groups.size > 0) {
          lines.push(
            '',
            `### Listener records by ${group_by.map(k => GROUP_LABELS[k].toLowerCase()).join(' × ')}`,
            '',
            markdownTable(
              [
                groupHeader(group_by),
                'Records',
                'Distinct contexts',
                'Registries',
              ],
              [...groups.entries()]
                .sort((a, b) => b[1].records - a[1].records)
                .slice(0, limit)
                .map(([key, g]) => [
                  renderKey(key, group_by),
                  formatNumber(g.records),
                  formatNumber(g.contexts.size),
                  formatNumber(g.emitters.size),
                ]),
              new Set([1, 2, 3]),
            ),
            '',
            '_Records far above distinct contexts: the same subscribers bound many times. Distinct contexts that grow per rung: subscribers piling up (`run_dir` with this `group_by`)._',
          );
        }
        if (timedOut) {
          lines.push(
            '',
            `⚠ Scan hit the ${timeout_ms}ms budget — results are partial. Raise timeout_ms for full coverage.`,
          );
        }
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
