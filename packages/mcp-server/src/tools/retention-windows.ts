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
 * What retention windows does this app have?
 *
 * A ladder can only distinguish "unbounded leak" from "working set bounded by a
 * window" if it spans longer than the window. A measured sweep reported three
 * populations as unbounded at r2 >= 0.9996 across twenty rounds; they were
 * bounded by a 30-minute `cleanUpTraceTimeout`, and every round drove for ~20
 * minutes, so nothing could ever expire and no ladder in that sweep could have
 * seen the plateau. The finding was published and retracted while a fix was
 * being written.
 *
 * The window that mattered was a named config key sitting in the heap the whole
 * time. Nobody looked, because there was nothing to look WITH — `memlab_app_config`
 * answers "what is flag X?" and you have to already suspect X.
 *
 * So this enumerates the duration-shaped config surface: property names that
 * read like a timeout, TTL, expiry, cleanup interval or retention window, with
 * their values where the capture records them. It is deliberately a NAME scan.
 * A key called `cleanUpTraceTimeout` tells you a window exists and what to grep
 * for even when its value is unreadable, and that is the half that changes the
 * verdict.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * Property names that denote a bound on how long something is kept.
 *
 * Deliberately broad: a false positive costs one table row, a false negative
 * costs a retracted finding.
 */
const WINDOW_KEY =
  /(timeout|ttl|max_?age|maxage|expir|retention|cleanup|clean_?up|evict|stale|window|interval|debounce|throttle|linger|keepalive|keep_?alive)/i;

/**
 * Names that match the regex but never denote a retention window, so they do
 * not crowd out the ones that do.
 */
const NOT_A_WINDOW = /^(timeoutId|timeoutID|_timeout|intervalId|intervalID)$/;

/** Render a millisecond count the way a human reasons about a window. */
export function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return String(ms);
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 90) return `${Math.round(s * 10) / 10} s`;
  const m = s / 60;
  if (m < 90) return `${Math.round(m * 10) / 10} min`;
  const h = m / 60;
  return `${Math.round(h * 10) / 10} h`;
}

/**
 * A plain integer property value, when the snapshot records one.
 *
 * Deliberately conservative. A `heap number`'s value is not stored in a heap
 * snapshot at all, and SMI decoding is a per-capture calibration that can be
 * wrong. Returning `null` and saying so beats printing a number that is
 * confidently incorrect — a bogus window is worse than an unknown one, because
 * it gets quoted.
 */
function readIntish(node: IHeapNode): number | null {
  if (node.type !== 'number') return null;
  // `decodeSmi` lives in app-config and is calibration-dependent; rather than
  // couple to it, only report values V8 exposes unambiguously through the node
  // name (some captures carry it, most do not).
  const n = Number(node.name);
  return Number.isFinite(n) ? n : null;
}

interface WindowHit {
  key: string;
  owner: string;
  value: number | null;
  count: number;
}

export function registerRetentionWindows(server: McpServer): void {
  server.tool(
    'memlab_retention_windows',
    'List the retention windows this app has — timeouts, TTLs, cleanup intervals, eviction ages — before calling any growth unbounded.\n\n' +
      'A LINEAR fit over a ladder is only evidence of an unbounded leak if the ladder spans LONGER than every window that could bound the population. It usually does not: a hunt drives for 15-30 minutes and apps routinely keep things for 30 minutes. A measured sweep published "unbounded leak, r2 = 0.9996" for three populations bounded by a 30-minute cleanup timer, then retracted it — the timer was a named config key resident in the capture the entire time.\n\n' +
      'This is a NAME scan over property keys that denote a bound (`*Timeout`, `*TTL`, `maxAge`, `cleanUp*`, `retention*`, `evict*`, `*Interval`), reported with their values WHERE THE CAPTURE RECORDS THEM. Most numeric values are not recorded in a heap snapshot at all, so an unreadable value is normal and is NOT evidence the window is absent — the key name alone tells you a window exists and what to grep for in the source, which is the half that changes the verdict.\n\n' +
      'Pair with `memlab_rate_model`: this says what windows exist, that says whether the series fits a plateau.',
    {
      pattern: z
        .string()
        .optional()
        .describe(
          'Additional case-insensitive regex OR-ed with the built-in window-name pattern, for an app whose naming this does not cover.',
        ),
      ladder_span_seconds: z
        .number()
        .optional()
        .describe(
          "The wall-clock span of the ladder you are judging (run.json's `elapsed_s`). When given, every window LONGER than the span is flagged: those are precisely the ones your ladder cannot distinguish from unbounded growth.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(40)
        .describe('Maximum distinct window-shaped keys to report.'),
    },
    async ({pattern, ladder_span_seconds, limit}) => {
      try {
        const snapshot = getSnapshot();
        if (!snapshot) {
          return errorResult(
            new Error(
              'No heap snapshot loaded. Use memlab_load_snapshot first.',
            ),
          );
        }
        const extra = pattern != null ? new RegExp(pattern, 'i') : null;

        // key -> hit. Aggregated by NAME: the same config key is typically
        // present on many objects (per-instance copies, a registry, a frozen
        // default), and forty rows of the same key is not an answer.
        const byKey = new Map<string, WindowHit>();

        snapshot.nodes.forEach((node: IHeapNode) => {
          if (node.type !== 'object') return;
          for (const edge of node.references) {
            if (edge.type !== 'property') continue;
            const key = edge.name_or_index;
            if (typeof key !== 'string' || key === '') continue;
            if (NOT_A_WINDOW.test(key)) continue;
            if (!WINDOW_KEY.test(key) && !(extra && extra.test(key))) continue;

            const existing = byKey.get(key);
            const value = readIntish(edge.toNode);
            if (existing == null) {
              byKey.set(key, {key, owner: node.name, value, count: 1});
            } else {
              existing.count++;
              // Prefer any readable value over none.
              if (existing.value == null && value != null) {
                existing.value = value;
              }
            }
          }
        });

        if (byKey.size === 0) {
          return toolResult(
            '## Retention windows\n\nNo window-shaped property names found.\n\n' +
              '_This is a name scan, so it misses a window held only in a closure variable or ' +
              'baked into a literal at the call site (`setTimeout(fn, 30 * 60 * 1000)` stores no ' +
              'named key). A miss is not evidence there is no window — check the source for the ' +
              'cleanup path of whatever population you are judging._',
          );
        }

        const spanMs =
          ladder_span_seconds != null ? ladder_span_seconds * 1000 : null;

        const hits = [...byKey.values()].sort((a, b) => {
          // Readable values first (they are the actionable rows), then by how
          // widely the key appears.
          if ((a.value == null) !== (b.value == null)) {
            return a.value == null ? 1 : -1;
          }
          return b.count - a.count;
        });

        let exceeding = 0;
        const rows = hits.slice(0, limit).map(h => {
          const overLadder =
            spanMs != null && h.value != null && h.value > spanMs;
          if (overLadder) exceeding++;
          return [
            h.key,
            h.owner,
            formatNumber(h.count),
            h.value == null ? '(not recorded)' : humanDuration(h.value),
            overLadder ? '⚠️ longer than ladder' : '',
          ];
        });

        const lines: string[] = [
          '## Retention windows',
          '',
          `**${formatNumber(byKey.size)}** window-shaped key(s) found${
            hits.length > limit ? `; showing ${limit}` : ''
          }.`,
          '',
          markdownTable(
            ['Key', 'Owner', 'Instances', 'Value', 'vs ladder'],
            rows,
          ),
          '',
        ];

        if (spanMs != null) {
          lines.push(
            `_Ladder span: **${humanDuration(spanMs)}**. ${
              exceeding > 0
                ? `**${exceeding} window(s) are longer than it** — a population bounded by any of those is INDISTINGUISHABLE from an unbounded leak on this ladder. Extend the ladder past the window, or run \`memlab_rate_model\` to test the series against a saturating curve.`
                : 'No readable window exceeds it, but see the caveat below before reading that as "therefore unbounded".'
            }_`,
          );
          lines.push('');
        }

        lines.push(
          '_Values are reported only where the capture records them. A `heap number` carries no ' +
            'value in a heap snapshot, so `(not recorded)` is the common case and is NOT evidence ' +
            'the window is small — grep the key in the source. Equally, this is a name scan: a ' +
            'window written as a literal at the call site (`setTimeout(fn, 30 * 60 * 1000)`) has no ' +
            'named key and will not appear here._',
        );

        return toolResult(lines.join('\n'));
      } catch (e: unknown) {
        return errorResult(e);
      }
    },
  );
}
