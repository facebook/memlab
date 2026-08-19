/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {
  getCurrentHandle,
  getMetadataByHandle,
  getSnapshotByHandle,
  listSnapshots,
} from '../heap-state.js';
import {selectPopulation} from './trace-all.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * Node ids are per-capture, so nothing in a snapshot pair says whether two
 * populations of the same size are the SAME objects. That distinction decides
 * what kind of bug is in front of you: a population that is churning (old
 * members replaced by new ones) is a rate problem, while one whose members all
 * persist is retention, and the two have different fixes. Counting cannot tell
 * them apart, and a count is what every existing diff reports.
 *
 * A content key stands in for identity: the object's property names plus the
 * string values it holds. It is not a true identity — two objects with the same
 * content are indistinguishable to it, which is exactly why the number of
 * distinct keys is reported alongside the population size. When keys collide
 * heavily the answer is weak, and the tool says so rather than implying that
 * "80% persisted" is a fact about object identity.
 */
function contentKey(node: IHeapNode, maxValues: number): string {
  const props: string[] = [];
  const values: string[] = [];
  for (const edge of node.references) {
    if (edge.type !== 'property') continue;
    const name = String(edge.name_or_index);
    props.push(name);
    if (values.length < maxValues) {
      const target = edge.toNode;
      if (target.type === 'string' || target.type === 'concatenated string') {
        values.push(`${name}=${target.name.slice(0, 64)}`);
      } else if (target.name === 'true' || target.name === 'false') {
        values.push(`${name}=${target.name}`);
      }
    }
  }
  props.sort();
  values.sort();
  return `{${props.join(',')}}|${values.join('|')}`;
}

function keyCounts(
  snapshot: IHeapSnapshot,
  sel: {className?: string; shape?: string[]},
  maxValues: number,
): {counts: Map<string, number>; total: number} {
  const counts = new Map<string, number>();
  const nodes = selectPopulation(snapshot, sel);
  for (const node of nodes) {
    const k = contentKey(node, maxValues);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return {counts, total: nodes.length};
}

export function registerIdentityDiff(server: McpServer): void {
  server.tool(
    'memlab_identity_diff',
    'Same objects, or just the same number of objects? Matches a population across two snapshots by CONTENT rather than by node id, which is not comparable across captures.\n\n' +
      'The distinction decides what kind of bug this is. A population whose members are replaced between captures is churn — a rate problem, and capping or reusing is the fix. A population whose members all persist is retention, and the fix is releasing them. The two look identical in every count-based diff, which is what `memlab_diff_snapshots` and a class histogram report.\n\n' +
      "The content key is the object's property names plus the string and boolean values it holds. That is a stand-in for identity, not identity: objects with identical content are indistinguishable to it. The report always states how distinct the keys actually were, so a weak answer is visible as one.",
    {
      before_handle: z
        .string()
        .describe(
          'Handle of the earlier snapshot (memlab_snapshots lists them).',
        ),
      after_handle: z.string().describe('Handle of the later snapshot.'),
      class_name: z
        .string()
        .optional()
        .describe('Population: every instance of this class.'),
      shape: z
        .array(z.string())
        .optional()
        .describe(
          'Population: every object carrying ALL of these properties — the selector to use on a minified heap.',
        ),
      max_values: z
        .number()
        .optional()
        .default(8)
        .describe(
          'String/boolean property values folded into the key (default 8). More values means a sharper key and more sensitivity to incidental differences; fewer means more collisions.',
        ),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe('Example keys to show per category (default 10).'),
    },
    async ({
      before_handle,
      after_handle,
      class_name,
      shape,
      max_values,
      limit,
    }) => {
      try {
        if ((class_name == null) === (shape == null || shape.length === 0)) {
          return errorResult(
            new Error('Pass exactly one of class_name / shape.'),
          );
        }
        if (before_handle === after_handle) {
          return errorResult(
            new Error('before_handle and after_handle are the same snapshot.'),
          );
        }
        const resolve = (h: string) => {
          const snap = getSnapshotByHandle(h);
          const meta = getMetadataByHandle(h);
          if (snap == null || meta == null) {
            throw new Error(
              `No resident snapshot with handle "${h}". Resident: ${
                listSnapshots()
                  .map(m => m.handle)
                  .join(', ') || '(none)'
              }. Load both with memlab_load_snapshot({keep_previous: true}).`,
            );
          }
          return {snap, meta};
        };
        const before = resolve(before_handle);
        const after = resolve(after_handle);

        const sel = {className: class_name, shape};
        const b = keyCounts(before.snap, sel, max_values);
        const a = keyCounts(after.snap, sel, max_values);
        if (b.total === 0 && a.total === 0) {
          return toolResult(
            'The population is empty in both snapshots — nothing to compare.',
          );
        }

        let persisted = 0;
        let gone = 0;
        let appeared = 0;
        const goneKeys: Array<[string, number]> = [];
        const newKeys: Array<[string, number]> = [];
        for (const [k, n] of b.counts) {
          const after_n = a.counts.get(k) ?? 0;
          persisted += Math.min(n, after_n);
          if (after_n < n) {
            gone += n - after_n;
            goneKeys.push([k, n - after_n]);
          }
        }
        for (const [k, n] of a.counts) {
          const before_n = b.counts.get(k) ?? 0;
          if (n > before_n) {
            appeared += n - before_n;
            newKeys.push([k, n - before_n]);
          }
        }
        goneKeys.sort((x, y) => y[1] - x[1]);
        newKeys.sort((x, y) => y[1] - x[1]);

        const persistShare = b.total > 0 ? (persisted / b.total) * 100 : 0;
        const distinctBefore = b.counts.size;
        const distinctAfter = a.counts.size;
        // A key that covers hundreds of objects cannot distinguish them, so the
        // persisted/churned split it produces is not evidence about identity.
        const collisionsBefore =
          b.total > 0 ? b.total / Math.max(1, distinctBefore) : 0;
        const collisionsAfter =
          a.total > 0 ? a.total / Math.max(1, distinctAfter) : 0;
        const weak = Math.max(collisionsBefore, collisionsAfter) >= 10;

        const label =
          class_name != null
            ? `class \`${class_name}\``
            : `shape \`{${(shape ?? []).join(', ')}}\``;

        const lines: string[] = [
          `## Identity of ${label}: ${before.meta.fileName} → ${after.meta.fileName}`,
          '',
          `Population **${formatNumber(b.total)} → ${formatNumber(a.total)}**. Matching by content key: **${formatNumber(persisted)} persisted** (${persistShare.toFixed(1)}% of the earlier population), ${formatNumber(gone)} gone, ${formatNumber(appeared)} new.`,
          '',
          weak
            ? `⚠ **The key is not discriminating here** — ${formatNumber(distinctBefore)} / ${formatNumber(distinctAfter)} distinct keys for ${formatNumber(b.total)} / ${formatNumber(a.total)} objects, so one key covers ~${Math.round(Math.max(collisionsBefore, collisionsAfter))} objects on average. The persisted/churned split above is arithmetic over buckets, NOT evidence about which objects survived. Raise \`max_values\`, or narrow the population first.`
            : `Key resolution: ${formatNumber(distinctBefore)} / ${formatNumber(distinctAfter)} distinct keys for ${formatNumber(b.total)} / ${formatNumber(a.total)} objects — discriminating enough for the split above to mean something.`,
          '',
          weak
            ? '_No verdict: with a key this undiscriminating, "persisted" and "churned" are properties of the buckets, not of the objects. Sharpen the key or narrow the population first._'
            : persistShare >= 90
              ? appeared > 0
                ? '**Retention, not churn:** nearly the whole earlier population is still present AND new members were added. Old members are not being replaced, they are accumulating.'
                : '**Stable population:** the same content is present in both captures and nothing was added. Whatever changed in the heap, it was not this.'
              : persistShare <= 25
                ? '**Churn, not retention:** most of the earlier population is gone and has been replaced. A count that looks flat here is a rate problem, not a leak — capping or reusing is the fix, releasing is not.'
                : 'Mixed: part of the population persists and part turns over. Split it further (by shape or by owner) before treating either reading as the explanation.',
        ];

        if (newKeys.length > 0) {
          lines.push(
            '',
            '### Content that is new',
            '',
            markdownTable(
              ['Count', 'Content key'],
              newKeys
                .slice(0, limit)
                .map(([k, n]) => [
                  formatNumber(n),
                  k.length > 100 ? k.slice(0, 97) + '…' : k,
                ]),
              new Set([0]),
            ),
          );
        }
        if (goneKeys.length > 0) {
          lines.push(
            '',
            '### Content that disappeared',
            '',
            markdownTable(
              ['Count', 'Content key'],
              goneKeys
                .slice(0, limit)
                .map(([k, n]) => [
                  formatNumber(n),
                  k.length > 100 ? k.slice(0, 97) + '…' : k,
                ]),
              new Set([0]),
            ),
          );
        }

        lines.push(
          '',
          `_Content equality is not object identity: two distinct objects with the same properties and values count as the same key, and one object whose contents changed between captures counts as one gone and one new. Active snapshot unchanged (${getCurrentHandle() ?? 'none'})._`,
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
