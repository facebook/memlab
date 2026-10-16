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
import memlabCore from '@memlab/core';
import {z} from 'zod';
import {loadRunManifest} from '../run-manifest.js';
import {resolveLadderPaths} from './ladder.js';
import {linearFit} from './ladder-probe.js';
import {
  ensureSidecar,
  normalizeClassName,
  readSidecarAsync,
  type SnapshotIndex,
} from '../snapshot-index.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

const {utils: memlabUtils} = memlabCore;

/**
 * Strings by PREFIX across a ladder, answered from each rung's sidecar index.
 *
 * A string node's class name is its content, and the sidecar keeps an exact
 * per-class count, so "how many `blob:` URLs are on this rung" is a scan of
 * the sidecar's class table rather than a walk of a 5M-node graph — measured
 * at ~60 s per rung when done by hand inside `memlab_ladder_probe`. A rung
 * without a sidecar is parsed once (light) and gets one, so the next call is
 * index-speed too.
 */

const STRING_TYPES = new Set([
  'string',
  'concatenated string',
  'sliced string',
]);

export function prefixCounts(
  index: SnapshotIndex,
  prefixes: readonly string[],
): Map<string, {count: number; distinct: number; bytes: number}> {
  const out = new Map(
    prefixes.map(p => [p, {count: 0, distinct: 0, bytes: 0}]),
  );
  // One value can appear under several string types (flat, cons, sliced);
  // distinct counts values, not class keys.
  const values = new Map(prefixes.map(p => [p, new Set<string>()]));
  for (const [key, [count, bytes]] of Object.entries(index.classes)) {
    const sep = key.indexOf('::');
    if (sep < 0 || !STRING_TYPES.has(key.slice(0, sep))) continue;
    const value = key.slice(sep + 2);
    for (const p of prefixes) {
      if (!value.startsWith(p)) continue;
      const row = out.get(p) as {
        count: number;
        distinct: number;
        bytes: number;
      };
      row.count += count;
      values.get(p)?.add(value);
      row.bytes += bytes;
    }
  }
  for (const [p, set] of values) {
    const row = out.get(p);
    if (row != null) row.distinct = set.size;
  }
  return out;
}

async function indexFor(
  path: string,
): Promise<{index: SnapshotIndex; cached: boolean}> {
  const cached = await readSidecarAsync(path);
  if (cached != null) return {index: cached, cached: true};
  const snapshot = await memlabUtils.getSnapshotFromFile(path, {
    buildNodeIdIndex: true,
    verbose: false,
  });
  return {
    index: ensureSidecar(snapshot, path, normalizeClassName),
    cached: false,
  };
}

export function registerStringPrefixCensus(server: McpServer): void {
  server.tool(
    'memlab_string_prefix_census',
    "Count strings by PREFIX on every rung of a ladder — `blob:` object URLs, `data:image/` payloads, a request-id or cache-key scheme — from each rung's sidecar index, without walking the graph. A rung with no sidecar is parsed once (light) and gets one. Reports per-rung count, distinct values and self bytes per prefix, with a per-cycle rate. Use it instead of a full-heap string walk inside `memlab_ladder_probe`.",
    {
      prefixes: z
        .array(z.string().min(1))
        .min(1)
        .describe('String prefixes to count, e.g. ["blob:", "data:image/"].'),
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
    },
    async ({prefixes, run_dir, paths}) => {
      try {
        let rungPaths: string[];
        let axis: number[] | null = null;
        if (run_dir != null) {
          const m = loadRunManifest(run_dir);
          rungPaths = m.paths;
          axis = m.cyclesPerRung;
          if (m.settleRungPath != null)
            rungPaths = [...rungPaths, m.settleRungPath];
        } else if (paths != null && paths.length > 0) {
          rungPaths = resolveLadderPaths(paths).paths;
        } else {
          return errorResult(
            new Error('Pass run_dir or paths (oldest first).'),
          );
        }
        // A rung that cannot be read is a gap in its column, not the end of
        // the census.
        const perRung: Array<ReturnType<typeof prefixCounts> | null> = [];
        const failures: string[] = [];
        let parsed = 0;
        for (const p of rungPaths) {
          try {
            const {index, cached} = await indexFor(p);
            perRung.push(prefixCounts(index, prefixes));
            // Counted only once the rung answered, so a failure is not also
            // counted as parsed.
            if (!cached) parsed++;
          } catch (err) {
            perRung.push(null);
            failures.push(
              `${p.replace(/^.*\//, '')}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        const labels = rungPaths.map((p, i) =>
          axis != null && i < axis.length
            ? `c${axis[i]}`
            : p.replace(/^.*\//, '').replace(/\.heapsnapshot$/, ''),
        );
        const driven = axis != null ? axis.length : rungPaths.length;
        const xs = axis ?? rungPaths.map((_, i) => i);
        // The newest driven rung that could be read, named in the headers.
        let lastAt = driven - 1;
        while (lastAt >= 0 && perRung[lastAt] == null) lastAt--;
        const lastLabel = lastAt >= 0 ? labels[lastAt] : 'last driven rung';
        const rows = prefixes.map(prefix => {
          const counts = perRung.map(r =>
            r == null ? null : (r.get(prefix)?.count ?? 0),
          );
          const pts = counts
            .slice(0, driven)
            .map((c, i) => ({c, x: xs[i]}))
            .filter((p): p is {c: number; x: number} => p.c != null);
          const fit =
            pts.length >= 2
              ? linearFit(
                  pts.map(p => p.x),
                  pts.map(p => p.c),
                )
              : null;
          const last = lastAt >= 0 ? perRung[lastAt]?.get(prefix) : null;
          return [
            `\`${prefix}\``,
            ...counts.map(c => (c == null ? 'unreadable' : formatNumber(c))),
            fit == null
              ? '—'
              : `${fit.slope >= 0 ? '+' : ''}${fit.slope.toFixed(3)}`,
            last != null ? formatNumber(last.distinct) : '—',
            last != null ? formatBytes(last.bytes) : '—',
          ];
        });
        return toolResult(
          [
            `## Strings by prefix across ${rungPaths.length} rung(s)`,
            '',
            markdownTable(
              [
                'Prefix',
                ...labels,
                `Δ/${axis != null ? 'cycle' : 'rung'}`,
                `Distinct (${lastLabel})`,
                `Self bytes (${lastLabel})`,
              ],
              rows,
            ),
            '',
            `_${formatNumber(rungPaths.length - parsed - failures.length)} of ${formatNumber(rungPaths.length)} rung(s) answered from a sidecar index; ${formatNumber(parsed)} parsed (light) and indexed now._`,
            ...(failures.length > 0
              ? ['', 'Unreadable rungs:', ...failures.map(f => `- ${f}`)]
              : []),
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
