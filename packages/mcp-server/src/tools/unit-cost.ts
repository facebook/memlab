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
import memlabCore from '@memlab/core';
import {z} from 'zod';
import {
  getCurrentHandle,
  getMetadataByHandle,
  getSnapshot,
  getSnapshotByHandle,
} from '../heap-state.js';
import {
  boundedDominatorRetainedSize,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

const {NumericSet} = memlabCore;

interface Population {
  count: number;
  retained: number;
  exact: boolean;
}

function matchesShape(node: IHeapNode, shape: string[]): boolean {
  if (shape.length === 0) return false;
  const want = new Set(shape);
  for (const e of node.references) {
    if (e.type !== 'property') continue;
    want.delete(String(e.name_or_index));
    if (want.size === 0) return true;
  }
  return false;
}

function measure(
  snapshot: IHeapSnapshot,
  opts: {className?: string; shape?: string[]},
): Population {
  const ids: number[] = [];
  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;
    if (opts.className != null) {
      if (node.name !== opts.className) return;
    } else if (opts.shape != null) {
      if (!matchesShape(node, opts.shape)) return;
    }
    ids.push(node.id);
  });
  if (ids.length === 0) return {count: 0, retained: 0, exact: true};
  const {retained, exact} = boundedDominatorRetainedSize(
    new NumericSet(ids),
    snapshot,
  );
  return {count: ids.length, retained, exact};
}

export function registerUnitCost(server: McpServer): void {
  server.tool(
    'memlab_unit_cost',
    'How much memory does ONE of these actually cost? Reports dominator-deduped retained bytes per instance for a class or an object shape, ' +
      'and — given two snapshots — separates the AVERAGE from the MARGINAL cost.\n\n' +
      'That distinction decides fixes. A population whose first instances drag in shared structure has a high average and a low marginal cost, ' +
      'so capping it saves far less than the average implies; a population with a flat per-instance cost scales linearly and a cap saves exactly ' +
      'what the arithmetic says. Sizing an LRU, an undo-stack cap, an eviction policy or a "is this worth interning?" decision all need the ' +
      'marginal number, and computing it by hand means four calls and a subtraction that is easy to get backwards.\n\n' +
      'With one snapshot you get the average and a projection table. With `baseline_handle` you also get the marginal cost between the two rungs.',
    {
      class_name: z
        .string()
        .optional()
        .describe(
          'Class/constructor name as reported by memlab_class_histogram (exact match). Use this OR shape.',
        ),
      shape: z
        .array(z.string())
        .optional()
        .describe(
          'Property names an instance must ALL carry, e.g. ["callback","context"]. Use for minified heaps where the class name is meaningless. Use this OR class_name.',
        ),
      handle: z
        .string()
        .optional()
        .describe('Snapshot to measure (defaults to the active one).'),
      baseline_handle: z
        .string()
        .optional()
        .describe(
          'Earlier snapshot. When given, the marginal cost is (retained_now − retained_baseline) / (count_now − count_baseline) — what one MORE instance costs, which is the number a cap or eviction policy is sized against.',
        ),
      project_caps: z
        .array(z.number())
        .optional()
        .describe(
          'Instance counts to project retained size for, e.g. [100, 500, 2000] when choosing a cache cap. Uses the marginal cost when available, otherwise the average (and says which).',
        ),
    },
    async ({class_name, shape, handle, baseline_handle, project_caps}) => {
      try {
        if (class_name == null && (shape == null || shape.length === 0)) {
          return errorResult(
            new Error(
              'Pass class_name or shape. On a minified heap prefer shape — class names like "t"/"e" match thousands of unrelated objects.',
            ),
          );
        }
        if (class_name != null && shape != null && shape.length > 0) {
          return errorResult(new Error('Pass class_name OR shape, not both.'));
        }

        const target =
          handle != null ? getSnapshotByHandle(handle) : getSnapshot();
        if (target == null) {
          return errorResult(
            new Error(`Snapshot "${handle}" is not resident.`),
          );
        }
        const targetLabel = handle ?? getCurrentHandle() ?? '(active)';

        const now = measure(target, {className: class_name, shape});
        if (now.count === 0) {
          return toolResult(
            `No instances found for ${class_name != null ? `class \`${class_name}\`` : `shape {${(shape ?? []).join(', ')}}`} in \`${targetLabel}\`. ` +
              'For a class, check the exact name with memlab_class_histogram; for a shape, with memlab_shape_histogram.',
          );
        }

        const average = now.retained / now.count;
        let marginal: number | null = null;
        let base: Population | null = null;
        if (baseline_handle != null) {
          const baseSnapshot = getSnapshotByHandle(baseline_handle);
          if (baseSnapshot == null) {
            return errorResult(
              new Error(
                `Baseline snapshot "${baseline_handle}" is not resident.`,
              ),
            );
          }
          base = measure(baseSnapshot, {className: class_name, shape});
          const dCount = now.count - base.count;
          const dBytes = now.retained - base.retained;
          if (dCount > 0) marginal = dBytes / dCount;
        }

        const label =
          class_name != null
            ? `class \`${class_name}\``
            : `shape \`{${(shape ?? []).join(', ')}}\``;
        const lines: string[] = [
          `## Unit cost — ${label}`,
          '',
          `\`${targetLabel}\`${getMetadataByHandle(targetLabel) ? ` (${getMetadataByHandle(targetLabel)?.fileName})` : ''}: ` +
            `**${formatNumber(now.count)} instances retaining ${formatBytes(now.retained)}**${now.exact ? '' : ' (upper bound — the dominator walk hit its depth cap)'}.`,
          '',
          `- **Average**: ${formatBytes(Math.round(average))} per instance.`,
        ];

        if (base != null && marginal != null) {
          lines.push(
            `- **Marginal**: ${formatBytes(Math.round(marginal))} per instance — measured across ${formatNumber(now.count - base.count)} added instances between \`${baseline_handle}\` (${formatNumber(base.count)} / ${formatBytes(base.retained)}) and \`${targetLabel}\`.`,
          );
          const ratio = average > 0 ? marginal / average : 1;
          if (ratio < 0.6) {
            lines.push(
              '',
              `⚠ Marginal is ${(ratio * 100).toFixed(0)}% of average: much of what this population retains is **shared structure the first instances pulled in**, not per-instance data. Size any cap or eviction policy on the marginal figure — the average overstates what capping saves.`,
            );
          } else if (ratio > 1.4) {
            lines.push(
              '',
              `⚠ Marginal is ${(ratio * 100).toFixed(0)}% of average: later instances cost MORE than earlier ones (they are retaining progressively more, or a shared structure is growing with them). Check whether the cost per instance is itself unbounded before sizing a cap.`,
            );
          } else {
            lines.push(
              '',
              '_Marginal ≈ average: the population scales linearly, so a cap saves what the arithmetic says._',
            );
          }
        } else if (baseline_handle != null) {
          lines.push(
            '',
            '_No marginal cost: the population did not grow between the two snapshots, so there is no delta to divide._',
          );
        } else {
          lines.push(
            '',
            '_Average only. Pass `baseline_handle` (an earlier rung) for the marginal cost — the two differ whenever the first instances drag in shared structure, and it is the marginal one that sizes a fix._',
          );
        }

        if (project_caps != null && project_caps.length > 0) {
          const unit = marginal ?? average;
          const usingMarginal = marginal != null;
          lines.push(
            '',
            `### Projected retained size at a cap (using the ${usingMarginal ? 'marginal' : 'average'} cost)`,
            '',
          );
          const rows = [...project_caps]
            .sort((a, b) => b - a)
            .map(cap => {
              const projected = Math.round(unit * Math.min(cap, now.count));
              const saved = Math.round(Math.max(0, now.retained - unit * cap));
              return [
                formatNumber(cap),
                formatBytes(projected),
                cap >= now.count ? '—' : formatBytes(saved),
              ];
            });
          lines.push(
            markdownTable(
              ['Cap (instances)', 'Projected retained', 'Saved vs today'],
              rows,
              new Set([0, 1, 2]),
            ),
          );
          lines.push(
            '',
            '_A projection, not a measurement: it assumes the per-instance cost holds at the cap and that evicted values are not co-retained elsewhere. Confirm the top candidate with `memlab_what_if` or a capped re-run._',
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
