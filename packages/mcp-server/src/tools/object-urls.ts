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
import type {IHeapSnapshot} from '@memlab/core';
import fs from 'fs';
import path from 'path';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {withSnapshotAt} from '../snapshot-borrow.js';
import {loadRunManifest} from '../run-manifest.js';
import {resolveLadderPaths} from './ladder.js';
import {linearFit} from './ladder-probe.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * Unrevoked `blob:` object URLs.
 *
 * An object URL pins its Blob in the browser's blob registry until
 * `URL.revokeObjectURL`, and those bytes are not in the V8 heap. A leak of
 * them is invisible to every heap-size metric: what IS in the heap is the URL
 * string, the Blob/File wrapper, and — when the page instruments
 * `URL.createObjectURL` — a register entry per live URL. Counting those per
 * rung is the heap-side signal; the bytes come from the page itself (the
 * leak-hunt runner records `object_url_bytes` per rung).
 */

const BLOB_PREFIX = 'blob:';
const MAX_UNIQUE = 200_000;

export interface ObjectUrlCounts {
  blobStrings: number;
  uniqueBlobUrls: number;
  // Objects keyed by `blob:` URLs (an instrumented createObjectURL register).
  registers: number;
  registerEntries: number;
  registerByType: Map<string, number>;
  blobs: number;
  files: number;
  // `<holder class>.<edge>` for the property edges holding `blob:` strings.
  holders: Map<string, number>;
}

export function countObjectUrls(snapshot: IHeapSnapshot): ObjectUrlCounts {
  const out: ObjectUrlCounts = {
    blobStrings: 0,
    uniqueBlobUrls: 0,
    registers: 0,
    registerEntries: 0,
    registerByType: new Map(),
    blobs: 0,
    files: 0,
    holders: new Map(),
  };
  const unique = new Set<string>();
  snapshot.nodes.forEach(node => {
    if (node.isString) {
      if (!node.name.startsWith(BLOB_PREFIX)) return;
      out.blobStrings++;
      if (unique.size < MAX_UNIQUE) unique.add(node.name);
      for (const e of node.referrers) {
        if (e.type !== 'property') continue;
        const key = `${e.fromNode.name || '(anonymous)'}.${String(e.name_or_index)}`;
        out.holders.set(key, (out.holders.get(key) ?? 0) + 1);
      }
      return;
    }
    if (node.type !== 'object') return;
    if (node.name === 'Blob') out.blobs++;
    else if (node.name === 'File') out.files++;
    let entries = 0;
    for (const e of node.references) {
      if (e.type !== 'property') continue;
      const key = e.name_or_index;
      if (typeof key !== 'string' || !key.startsWith(BLOB_PREFIX)) continue;
      entries++;
      let type = '(unknown)';
      for (const ve of e.toNode.references) {
        if (ve.name_or_index === 'type' && ve.toNode.isString) {
          type = ve.toNode.name;
          break;
        }
      }
      out.registerByType.set(type, (out.registerByType.get(type) ?? 0) + 1);
    }
    if (entries > 0) {
      out.registers++;
      out.registerEntries += entries;
    }
  });
  out.uniqueBlobUrls = unique.size;
  return out;
}

/** Per-rung in-page register totals the runner recorded, by rung index. */
function offHeapByRung(
  runDir: string,
): Array<{urls: number | null; bytes: number | null}> {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'),
    ) as {rungs?: Array<{off_heap?: Record<string, unknown>}>};
    return (raw.rungs ?? []).map(r => ({
      urls:
        typeof r.off_heap?.object_urls === 'number'
          ? r.off_heap.object_urls
          : null,
      bytes:
        typeof r.off_heap?.object_url_bytes === 'number'
          ? r.off_heap.object_url_bytes
          : null,
    }));
  } catch {
    return [];
  }
}

function rate(xs: number[], ys: number[]): string {
  if (xs.length < 2 || new Set(xs).size < 2) return '—';
  const fit = linearFit(xs, ys);
  return `${fit.slope >= 0 ? '+' : ''}${fit.slope.toFixed(3)}`;
}

function singleReport(c: ObjectUrlCounts): string {
  const lines = [
    '## Object URLs',
    '',
    markdownTable(
      ['Signal', 'Count'],
      [
        ['`blob:` URL strings (unique)', formatNumber(c.uniqueBlobUrls)],
        ['`blob:` string nodes', formatNumber(c.blobStrings)],
        [
          'createObjectURL register entries',
          c.registers > 0
            ? `${formatNumber(c.registerEntries)} (${[...c.registerByType]
                .map(([t, n]) => `${t} ${formatNumber(n)}`)
                .join(', ')})`
            : '— (no register found)',
        ],
        ['Live `Blob` wrappers', formatNumber(c.blobs)],
        ['Live `File` wrappers', formatNumber(c.files)],
      ],
      new Set([1]),
    ),
  ];
  const holders = [...c.holders].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (holders.length > 0) {
    lines.push(
      '',
      '**Who holds the URL strings** (property edges):',
      '',
      markdownTable(
        ['Holder.edge', 'URLs'],
        holders.map(([k, n]) => [`\`${k}\``, formatNumber(n)]),
        new Set([1]),
      ),
    );
  }
  lines.push(
    '',
    '_Each live URL pins its Blob OFF the V8 heap until it is revoked, so none of those bytes show in heap size. A URL count that grows with interaction is a leak of that off-heap memory even when the heap is flat. Pass `run_dir` for the per-rung trend and the byte totals the runner recorded._',
  );
  return lines.join('\n');
}

export function registerObjectUrls(server: McpServer): void {
  server.tool(
    'memlab_object_urls',
    'Unrevoked `blob:` object URLs — a leak that every heap-size metric misses, because each live URL pins its Blob in the browser blob registry, OFF the V8 heap. ' +
      'Counts `blob:` URL strings, the entries of an instrumented `URL.createObjectURL` register (grouped by File/Blob/MediaSource), live Blob/File wrappers, and which property edges hold the URLs. ' +
      'With `run_dir` (or `paths`) it counts every rung and reports per-cycle rates, plus the in-page register byte totals the leak-hunt runner records per rung (`object_url_bytes`). Without either it reads the loaded snapshot.',
    {
      run_dir: z
        .string()
        .optional()
        .describe(
          'A leak-hunt run directory: count every rung (and the settle rung) and read the per-rung off-heap byte totals from its run.json.',
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Ordered snapshot paths, oldest first (or ["ladder:<name>"]), instead of run_dir.',
        ),
    },
    async ({run_dir, paths}) => {
      try {
        if (run_dir == null && (paths == null || paths.length === 0)) {
          return toolResult(singleReport(countObjectUrls(getSnapshot())));
        }
        let rungPaths: string[];
        let axis: number[] | null = null;
        let settlePath: string | null = null;
        let offHeap: Array<{urls: number | null; bytes: number | null}> = [];
        if (run_dir != null) {
          const manifest = loadRunManifest(run_dir);
          rungPaths = manifest.paths;
          axis = manifest.cyclesPerRung;
          settlePath = manifest.settleRungPath;
          offHeap = offHeapByRung(run_dir);
        } else {
          rungPaths = resolveLadderPaths(paths as string[]).paths;
        }
        if (rungPaths.length === 0) {
          return errorResult(
            new Error('No rungs to count: the ladder is empty.'),
          );
        }
        const rows: Array<{label: string; c: ObjectUrlCounts}> = [];
        for (const p of rungPaths) {
          rows.push({
            label: p.replace(/^.*\//, ''),
            c: await withSnapshotAt(p, snap => countObjectUrls(snap)),
          });
        }
        const settle =
          settlePath != null
            ? await withSnapshotAt(settlePath, snap => countObjectUrls(snap))
            : null;
        // An axis that does not match the rungs is dropped, so the rate is
        // labeled per rung rather than mislabeled per cycle.
        if (axis != null && axis.length !== rows.length) axis = null;
        const xs = axis ?? rows.map((_, i) => i);
        const unit = axis != null ? 'cycle' : 'rung';
        const haveBytes = offHeap.some(o => o.bytes != null);
        const series: Array<[string, number[]]> = [
          ['`blob:` URLs (unique)', rows.map(r => r.c.uniqueBlobUrls)],
          ['register entries', rows.map(r => r.c.registerEntries)],
          ['Blob wrappers', rows.map(r => r.c.blobs)],
          ['File wrappers', rows.map(r => r.c.files)],
        ];
        const settleVals = settle
          ? [
              settle.uniqueBlobUrls,
              settle.registerEntries,
              settle.blobs,
              settle.files,
            ]
          : null;
        const table = series.map(([name, ys], i) => [
          name,
          ...ys.map(v => formatNumber(v)),
          ...(settleVals != null ? [formatNumber(settleVals[i])] : []),
          rate(xs, ys),
        ]);
        if (haveBytes) {
          const bytes = rows.map((_, i) => offHeap[i]?.bytes ?? null);
          // Fitted over the rungs that recorded bytes only: a rung that
          // failed to record is not a rung with 0 bytes.
          const measured = bytes
            .map((b, i) => ({b, x: xs[i]}))
            .filter((p): p is {b: number; x: number} => p.b != null);
          table.push([
            'register bytes (in-page)',
            ...bytes.map(b => (b == null ? '—' : formatBytes(b))),
            ...(settleVals != null ? ['—'] : []),
            rate(
              measured.map(p => p.x),
              measured.map(p => p.b / 1024),
            ) + ' KB',
          ]);
        }
        const lines = [
          '## Object URLs across the ladder',
          '',
          markdownTable(
            [
              'Signal',
              ...rows.map((r, i) => (axis != null ? `c${xs[i]}` : r.label)),
              ...(settle != null ? ['settled'] : []),
              `Δ/${unit}`,
            ],
            table,
          ),
          '',
        ];
        const last = rows[rows.length - 1].c;
        const holders = [...last.holders]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8);
        if (holders.length > 0) {
          lines.push(
            `**Holders of the URL strings on the last rung:** ${holders
              .map(([k, n]) => `\`${k}\` ${formatNumber(n)}`)
              .join(', ')}`,
            '',
          );
        }
        if (!haveBytes && run_dir != null) {
          lines.push(
            '_No `object_url_bytes` in this run.json: the page has no instrumented register, or the round predates the runner recording it. The counts above are still the trend; the pinned BYTES are not visible from the heap._',
            '',
          );
        }
        lines.push(
          '_A URL count rising per cycle and not falling on the settle rung is unrevoked object URLs: their Blobs stay pinned off-heap. Name the creator from the holder edges above, then check that every `createObjectURL` on that path has a matching `revokeObjectURL`._',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
