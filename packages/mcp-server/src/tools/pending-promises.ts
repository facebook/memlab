/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {withSnapshotAt} from '../snapshot-borrow.js';
import {loadRunManifest} from '../run-manifest.js';
import {
  isPendingPromise,
  pendingPromises,
  promiseReactions,
} from '../promise-chains.js';
import {resolveLadderPaths} from './ladder.js';
import {linearFit} from './ladder-probe.js';
import {ownerLabel} from './async-census.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * The unsettled promises with the longest reaction chains, tracked by node id
 * across a ladder. Heap-snapshot ids are stable for one object within one V8
 * isolate, so the same promise can be read at every rung and its chain fitted
 * per cycle — the signature of a promise that never settles while every
 * interaction attaches another `.then`.
 */
export function registerPendingPromises(server: McpServer): void {
  server.tool(
    'memlab_pending_promises',
    'Unsettled Promises ranked by REACTION-CHAIN length, with retained size and the production owner path. One promise that never settles keeps every `.then` callback attached to it, so the leak is a long chain on ONE promise — invisible to a count of unsettled promises. ' +
      'With `run_dir` (or `paths`) it takes the top promises on the last rung and reads each one, by node id, at every rung: "+N reactions/cycle on one promise" is a promise that never settles while every interaction attaches to it. Without either it ranks the loaded snapshot.',
    {
      run_dir: z
        .string()
        .optional()
        .describe(
          'A leak-hunt run directory: track the top promises across its rungs.',
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe('Ordered snapshot paths, oldest first, instead of run_dir.'),
      top: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(10)
        .describe('How many promises to report (default 10).'),
    },
    async ({run_dir, paths, top}) => {
      try {
        if (run_dir == null && (paths == null || paths.length === 0)) {
          const snapshot = getSnapshot();
          const all = pendingPromises(snapshot);
          const rows = all
            .slice(0, top)
            .map(({node, reactions}) => [
              `@${node.id}`,
              formatNumber(reactions),
              formatBytes(node.retainedSize),
              ownerLabel(snapshot, node),
            ]);
          return toolResult(
            [
              `## Unsettled promises — ${formatNumber(all.length)} pending`,
              '',
              markdownTable(
                [
                  'Promise',
                  'Reactions',
                  'Retained',
                  'Owner (production path tail)',
                ],
                rows,
                new Set([1, 2]),
              ),
              '',
              '_Pass `run_dir` to see whether a chain grows per cycle._',
            ].join('\n'),
          );
        }

        let rungPaths: string[];
        let axis: number[] | null = null;
        if (run_dir != null) {
          const manifest = loadRunManifest(run_dir);
          rungPaths = manifest.paths;
          axis = manifest.cyclesPerRung;
        } else {
          rungPaths = resolveLadderPaths(paths as string[]).paths;
        }
        if (rungPaths.length < 2) {
          return errorResult(new Error('Need at least two rungs.'));
        }
        type Chain = {count: number; capped: boolean};
        const chainOf = (node: IHeapNode): Chain => {
          const {count, truncated} = promiseReactions(node);
          return {count, capped: truncated};
        };
        // The last rung picks the promises to track, and the same load gives
        // its own column and pending total.
        const last = rungPaths[rungPaths.length - 1];
        const {tracked, lastCounts, lastTotal} = await withSnapshotAt(
          last,
          snap => {
            const pending = pendingPromises(snap);
            const head = pending.slice(0, top);
            return {
              tracked: head.map(({node}) => ({
                id: node.id,
                owner: ownerLabel(snap, node),
                retained: node.retainedSize,
              })),
              lastCounts: head.map(({node}) => chainOf(node)),
              lastTotal: pending.length,
            };
          },
        );
        if (tracked.length === 0) {
          return toolResult('No unsettled promise on the last rung.');
        }
        const perRung: Array<Array<Chain | null>> = [];
        const pendingTotals: number[] = [];
        for (const p of rungPaths.slice(0, -1)) {
          const {counts, total} = await withSnapshotAt(p, snap => {
            // By id: no walk. Only the pending total needs one pass. A
            // promise that exists but has settled reads 0, not "absent".
            const out: Array<Chain | null> = tracked.map(t => {
              const node = snap.getNodeById(t.id);
              return node != null &&
                node.type === 'object' &&
                node.name === 'Promise'
                ? chainOf(node)
                : null;
            });
            let n = 0;
            snap.nodes.forEach(node => {
              if (isPendingPromise(node)) n++;
            });
            return {counts: out, total: n};
          });
          perRung.push(counts);
          pendingTotals.push(total);
        }
        perRung.push(lastCounts);
        pendingTotals.push(lastTotal);
        // An axis that does not match the rungs is dropped, so the rate is
        // labeled per rung rather than mislabeled per cycle.
        if (axis != null && axis.length !== rungPaths.length) axis = null;
        const xs = axis ?? rungPaths.map((_, i) => i);
        const unit = axis != null ? 'cycle' : 'rung';
        // Raw slopes, so the "growing" count does not re-read a rounded cell.
        const slopes: Array<number | null> = [];
        let atCap = 0;
        const rows = tracked.map((t, ti) => {
          const chains = perRung.map(r => r[ti]);
          const series = chains.map(c => c?.count ?? null);
          // A chain at the walk cap is at least that long, so its flat
          // series says nothing about growth.
          const capped = chains.some(c => c?.capped === true);
          const present = series
            .map((v, i) => ({v, x: xs[i]}))
            .filter((p): p is {v: number; x: number} => p.v != null);
          const slope =
            present.length >= 2 && new Set(present.map(p => p.x)).size >= 2
              ? linearFit(
                  present.map(p => p.x),
                  present.map(p => p.v),
                ).slope
              : null;
          // Its growth is unknown, so it is reported apart from the growers.
          if (capped) atCap++;
          slopes.push(capped ? null : slope);
          return [
            `@${t.id}`,
            ...chains.map(c =>
              c == null
                ? '—'
                : `${c.capped ? '≥' : ''}${formatNumber(c.count)}`,
            ),
            capped
              ? '? (at cap)'
              : slope == null
                ? '—'
                : `${slope >= 0 ? '+' : ''}${slope.toFixed(3)}`,
            formatBytes(t.retained),
            t.owner,
          ];
        });
        const growing = slopes.filter(s => s != null && s > 0).length;
        return toolResult(
          [
            `## Unsettled promises across ${rungPaths.length} rungs`,
            '',
            `Pending promises per rung: ${pendingTotals.map(formatNumber).join(' → ')}.`,
            '',
            markdownTable(
              [
                'Promise',
                ...rungPaths.map((p, i) =>
                  axis != null ? `c${xs[i]}` : p.replace(/^.*\//, ''),
                ),
                `Δ reactions/${unit}`,
                'Retained',
                'Owner (production path tail)',
              ],
              rows,
            ),
            '',
            growing > 0
              ? `**${growing} promise(s) gain reactions every ${unit}.** A promise that never settles while each interaction attaches a \`.then\` grows exactly like this; find what should resolve or reject it (a load that can fail without rejecting, a missing timeout).`
              : '_No tracked promise gains reactions across the ladder._',
            ...(atCap > 0
              ? [
                  '',
                  `**${atCap} promise(s) hold a chain at the walk cap** — at least that many reactions on one promise, growth unknown. Treat each as a leak until \`helpers.promiseReactions(id)\` says otherwise.`,
                ]
              : []),
            '',
            '_`—` = the promise does not exist at that rung (created later, or the page reloaded and ids changed). `≥N` = the chain walk stopped at its cap._',
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
