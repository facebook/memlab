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
 * Per-class growth between two snapshots, counting only what a production
 * build would also hold.
 *
 * Most of the noise in a sweep on a dev build was dev-only: Fast Refresh,
 * React `_debug*` owner chains, devtools interop. `memlab_artifact_budget`
 * gives the production TOTAL; this gives the per-class table under the same
 * rule, so "which class grew" is answered without the dev share mixed in.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {
  collectDevRoots,
  computeReachableWithoutDevRoots,
} from './dev-artifacts.js';
import {normalizeClassName} from '../snapshot-index.js';
import {
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
  withSnapshotAt,
} from '../snapshot-borrow.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

interface ClassTotals {
  all: Map<string, [number, number]>;
  prod: Map<string, [number, number]>;
  allBytes: number;
  prodBytes: number;
}

function census(snap: IHeapSnapshot): ClassTotals {
  const reached = computeReachableWithoutDevRoots(snap, collectDevRoots(snap));
  const all = new Map<string, [number, number]>();
  const prod = new Map<string, [number, number]>();
  let allBytes = 0;
  let prodBytes = 0;
  const bump = (m: Map<string, [number, number]>, k: string, size: number) => {
    const v = m.get(k);
    if (v) {
      v[0]++;
      v[1] += size;
    } else {
      m.set(k, [1, size]);
    }
  };
  snap.nodes.forEach(node => {
    if (node.id <= 3) return;
    const key = `${node.type}::${normalizeClassName(node.name)}`;
    allBytes += node.self_size;
    bump(all, key, node.self_size);
    if (reached[node.nodeIndex]) {
      prodBytes += node.self_size;
      bump(prod, key, node.self_size);
    }
  });
  return {all, prod, allBytes, prodBytes};
}

export function registerDevSubtractedDelta(server: McpServer): void {
  server.tool(
    'memlab_dev_subtracted_delta',
    'Per-class growth from `baseline` to `target` counting only nodes a PRODUCTION build would also hold: everything reachable solely through a dev root (console handles, devtools globals, Fast Refresh registries, the automation bridge) or a dev edge (React `_owner`/`_debug*`, dev-only modules) is removed first. On a dev build this is the honest "what did the app grow" table; the raw delta is shown beside it so the dev share of each class is visible.',
    {
      baseline: z.string().describe('Earlier snapshot path.'),
      target: z.string().describe('Later snapshot path.'),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Classes to list (default 20), by production-only growth.'),
      max_file_size_mb: z
        .number()
        .optional()
        .describe('Per-file size ceiling, matching memlab_load_snapshot.'),
    },
    async ({baseline, target, limit, max_file_size_mb}) => {
      try {
        const {rungs, largestMB} = resolveRungs(
          [baseline, target],
          max_file_size_mb,
        );
        armScanBudgetFor(scaledTimeoutMs(largestMB));
        const a = await withSnapshotAt(rungs[0].localPath, census);
        armScanBudgetFor(scaledTimeoutMs(largestMB));
        const b = await withSnapshotAt(rungs[1].localPath, census);

        const keys = new Set([...a.all.keys(), ...b.all.keys()]);
        const rows = [...keys]
          .map(k => {
            const pa = a.prod.get(k) ?? [0, 0];
            const pb = b.prod.get(k) ?? [0, 0];
            const ra = a.all.get(k) ?? [0, 0];
            const rb = b.all.get(k) ?? [0, 0];
            return {
              k,
              prodCount: pb[0] - pa[0],
              prodBytes: pb[1] - pa[1],
              rawCount: rb[0] - ra[0],
              rawBytes: rb[1] - ra[1],
            };
          })
          .filter(
            r =>
              r.prodCount !== 0 ||
              r.prodBytes !== 0 ||
              r.rawCount !== 0 ||
              r.rawBytes !== 0,
          )
          .sort((x, y) => y.prodBytes - x.prodBytes);
        const rawDelta = b.allBytes - a.allBytes;
        const prodDelta = b.prodBytes - a.prodBytes;
        const lines = [
          '## Production-only growth',
          '',
          `Raw self-size delta **${formatBytes(rawDelta)}**; with dev-only memory removed **${formatBytes(prodDelta)}** ` +
            `(dev-only share of the target: ${formatBytes(b.allBytes - b.prodBytes)}).`,
          '',
          markdownTable(
            [
              'Class',
              'Δ count (prod)',
              'Δ bytes (prod)',
              'Δ count (raw)',
              'Dev share of Δ bytes',
            ],
            rows.slice(0, limit).map(r => {
              const sep = r.k.indexOf('::');
              const name = r.k.slice(sep + 2);
              return [
                `${name.length > 50 ? name.slice(0, 49) + '…' : name} (${r.k.slice(0, sep)})`,
                `${r.prodCount >= 0 ? '+' : ''}${formatNumber(r.prodCount)}`,
                `${r.prodBytes >= 0 ? '+' : ''}${formatBytes(r.prodBytes)}`,
                `${r.rawCount >= 0 ? '+' : ''}${formatNumber(r.rawCount)}`,
                // A share only means something when both grew and prod is the
                // smaller part; prod shrinking while raw grew is not "100% dev".
                r.rawBytes > 0 && r.prodBytes >= 0 && r.prodBytes <= r.rawBytes
                  ? `${Math.round(((r.rawBytes - r.prodBytes) / r.rawBytes) * 100)}%`
                  : '—',
              ];
            }),
            new Set([1, 2, 3, 4]),
          ),
          '',
          '_A class whose raw growth is mostly dev share is the dev build growing, not the app. Self sizes; dominator-retained sizes need `memlab_what_if` on the population._',
        ];
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
