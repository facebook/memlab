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
import {resolveRungs} from '../snapshot-borrow.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';
import {resolveLadderPaths} from './ladder.js';

/**
 * Rough multiplier from on-disk snapshot bytes to resident bytes after a FULL
 * parse (graph + dominator tree).
 *
 * Deliberately a stated approximation rather than a measurement: the real factor
 * depends on node/edge ratio and string content, and the decision this feeds —
 * "can I hold two of these at once?" — only needs the right order of magnitude.
 * Quoting a precise-looking number here would imply an accuracy that is not
 * there, so the output says the estimate is an estimate.
 */
const FULL_PARSE_EXPANSION = 3;

/** A light parse skips the dominator pass and holds noticeably less. */
const LIGHT_PARSE_EXPANSION = 1.8;

export function registerSnapshotBudgetPlanner(server: McpServer): void {
  server.tool(
    'memlab_snapshot_budget_planner',
    'Which rungs of this ladder can you actually hold in memory at once, and which should be probed transiently?\n\n' +
      'The guidance is already known — a few well-spaced rungs for the trend, and only the final snapshot fully loaded ' +
      'for the deep-dive — but applying it means knowing what each rung costs, and that is a `stat` plus an expansion ' +
      'factor per file that nobody does. The failure it prevents is specific: `memlab_unit_cost` needs a ' +
      '`baseline_handle` to report MARGINAL cost (the number that actually sizes a cap), which needs two large ' +
      'snapshots resident at once. A session that does not know whether that fits either never asks for the marginal ' +
      'number or discovers the ceiling by hitting it mid-analysis.\n\n' +
      'Reports per-rung file size, estimated resident cost at full and light parse, what fits in the budget, and a ' +
      'concrete plan. Does no parsing of its own — this is a `stat` and some arithmetic.',
    {
      paths: z
        .array(z.string())
        .min(1)
        .describe(
          'Ordered snapshot paths, oldest rung first — the same forms memlab_ladder_probe accepts, including a single ["ladder:<name>"] reference.',
        ),
      budget_mb: z
        .number()
        .positive()
        .optional()
        .default(4096)
        .describe(
          'Resident memory you are willing to spend on snapshots, in MB. Default 4096, which is the practical ceiling before a V8 heap of its own becomes the problem.',
        ),
    },
    async ({paths, budget_mb}) => {
      try {
        const {paths: resolved} = resolveLadderPaths(paths);
        const {rungs} = resolveRungs(resolved);
        // `.min(1)` bounds the PATHS, not what they resolve to: a `ladder:` name
        // can expand to nothing. Everything below indexes rows[0] and
        // rows[length - 1] unconditionally, so an empty resolution would throw a
        // TypeError instead of saying what went wrong.
        if (rungs.length === 0) {
          return errorResult(
            new Error(
              `No rungs resolved from ${formatNumber(resolved.length)} path(s). Check the ladder name, or pass snapshot paths directly.`,
            ),
          );
        }

        const rows = rungs.map((r, i) => {
          const sizeMB = r.sizeMB;
          return {
            index: i,
            label: r.label,
            sizeMB,
            fullMB: sizeMB * FULL_PARSE_EXPANSION,
            lightMB: sizeMB * LIGHT_PARSE_EXPANSION,
          };
        });

        const totalFull = rows.reduce((a, r) => a + r.fullMB, 0);
        const largest = rows.reduce(
          (a, r) => (r.fullMB > a.fullMB ? r : a),
          rows[0],
        );
        const finalRung = rows[rows.length - 1];

        const lines: string[] = [
          `## Snapshot budget — ${rows.length} rung(s) against ${formatNumber(budget_mb)} MB`,
          '',
          markdownTable(
            ['Rung', 'File (MB)', 'Full parse (est.)', 'Light parse (est.)'],
            rows.map(r => [
              `${r.index}: ${r.label}`,
              r.sizeMB.toFixed(1),
              `${r.fullMB.toFixed(0)} MB`,
              `${r.lightMB.toFixed(0)} MB`,
            ]),
            new Set([1, 2, 3]),
          ),
          '',
          `Loading every rung fully would cost about **${totalFull.toFixed(0)} MB** — ` +
            `${totalFull <= budget_mb ? 'inside' : '**over**'} the ${formatNumber(budget_mb)} MB budget.`,
          '',
        ];

        // The two-resident question is the one worth answering directly,
        // because it is the one that silently costs a measurement.
        const twoLargest = [...rows]
          .sort((a, b) => b.fullMB - a.fullMB)
          .slice(0, 2)
          .reduce((a, r) => a + r.fullMB, 0);
        const canHoldTwo = rows.length >= 2 && twoLargest <= budget_mb;

        lines.push('### Plan', '');
        if (totalFull <= budget_mb) {
          lines.push(
            `- All ${rows.length} rungs fit fully resident. Load them and use \`memlab_eval_across\` freely.`,
          );
        } else {
          lines.push(
            `- **Fully load the final rung only** (${finalRung.label}, ~${finalRung.fullMB.toFixed(0)} MB) for the deep-dive.`,
            `- **Probe the rest transiently** with \`memlab_ladder_probe\`, which loads and drops one graph at a time and ` +
              'never needs two resident. Pass every metric you want in a single call — the load dominates, so N metrics ' +
              'cost about the same as one.',
          );
        }
        lines.push(
          rows.length < 2
            ? '- Marginal cost is not a question yet: a single rung has nothing to be marginal against. ' +
                '`memlab_unit_cost` with `baseline_handle` needs two rungs resident, so plan a second rung before ' +
                'costing anything per-instance.'
            : canHoldTwo
              ? `- Marginal cost IS affordable: the two largest rungs together are ~${twoLargest.toFixed(0)} MB, ` +
                'so `memlab_unit_cost` with `baseline_handle` will fit. Use it — average cost is the wrong number to ' +
                'size a cap against.'
              : `- Marginal cost is NOT affordable here: the two largest rungs together are ~${twoLargest.toFixed(0)} MB, ` +
                `over the ${formatNumber(budget_mb)} MB budget. \`memlab_unit_cost\` will only give you the AVERAGE, ` +
                'which overstates the saving whenever early instances drag in shared structure. Either raise the budget ' +
                'or pick two smaller rungs to compare.',
          '',
        );

        if (largest.fullMB > budget_mb) {
          lines.push(
            `> ⚠️ **The largest rung alone (${largest.label}, ~${largest.fullMB.toFixed(0)} MB) exceeds the budget.** ` +
              'Nothing here will fit fully parsed. Use LIGHT loads where the analysis allows it — but note that on a ' +
              'light snapshot `retainedSize` reads back 0 WITHOUT failing, so any retained-size figure taken from one ' +
              'is silently wrong rather than absent.',
            '',
          );
        }

        lines.push(
          `_Estimates, not measurements: resident cost is taken as ~${FULL_PARSE_EXPANSION}x file size for a full ` +
            `parse and ~${LIGHT_PARSE_EXPANSION}x for a light one. The real factor depends on the node/edge ratio and ` +
            'string content, so treat these as order-of-magnitude guidance for a load decision, not as a capacity guarantee._',
        );

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
