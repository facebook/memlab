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
import type {IHeapNode} from '@memlab/core';

import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {toolResult, formatNumber} from '../utils.js';

/**
 * Is a population one-per-live-owner, or is it piling up?
 *
 * This is the question that decides whether a finding is a leak or a standing
 * O(N) cost, and it changes what the fix has to do — bound the structure, or
 * just make it cheaper. It was answered by hand, with an eval, every time.
 *
 * Measured case: 419 `locale_change` subscriptions against 391 live chat
 * models. One per live owner. Reported as a leak until that ratio was computed,
 * at which point it became "structural, remove the per-owner cost" — a
 * different diff with a different claim.
 *
 * The ratio is the whole output. ~1.0 is structural. Well above 1.0 means
 * owners are accumulating records. Far below 1.0 means most owners have none,
 * which usually means the shape matched something other than what was intended.
 */
function shapeKeys(node: IHeapNode): Set<string> {
  const keys = new Set<string>();
  for (const e of node.references) {
    if (e.type !== 'property') continue;
    const n = String(e.name_or_index);
    if (n === '__proto__' || n === 'map') continue;
    keys.add(n);
  }
  return keys;
}

export function registerPopulationVsOwners(server: McpServer): void {
  server.tool(
    'memlab_population_vs_owners',
    'Decide whether a population is STRUCTURAL (about one record per live owner) or ACCUMULATING (owners are collecting records), by counting both and reporting the ratio. ' +
      'This is the question that separates "a leak" from "a standing O(number-of-owners) cost", and the two need different fixes and different claims — but nothing computed it, so it got hand-written as an eval, or skipped. Measured case: 419 listener records against 391 live models is one per owner, which turned a reported leak into a per-owner cost and changed the fix. ' +
      'Give it the records (by class or by property shape) and the owner class. It also names the owners holding the most records, which is where a real accumulation shows up even when the overall ratio looks fine.',
    {
      record_class: z
        .string()
        .optional()
        .describe(
          'Class name of the record population (as reported by memlab_class_histogram). Use this OR record_shape.',
        ),
      record_shape: z
        .array(z.string())
        .optional()
        .describe(
          'Property names every record carries, e.g. ["callback","context"]. Use this OR record_class. Preferred on a minified heap, where every record class is `Object` or `t`.',
        ),
      owner_edge: z
        .string()
        .optional()
        .default('context')
        .describe(
          'The edge on a record that points at its owner (default "context"; also common: "target", "model", "subscriber").',
        ),
      owner_class: z
        .string()
        .optional()
        .describe(
          'Class name of the owners, used to count how many are LIVE in the heap. Omit to infer it from the most common owner class among the records.',
        ),
      limit: z
        .number()
        .optional()
        .default(8)
        .describe('How many top owners to list (default 8).'),
    },
    async ({record_class, record_shape, owner_edge, owner_class, limit}) => {
      const snapshot = getSnapshot();
      if (!snapshot) {
        return toolResult(
          'Error: No heap snapshot loaded. Use memlab_load_snapshot first.',
        );
      }
      if (!record_class && (!record_shape || record_shape.length === 0)) {
        return toolResult(
          'Error: give either `record_class` or `record_shape`. On a minified heap prefer `record_shape` — every record class is `Object` or a one-letter name, so a class filter selects far too much.',
        );
      }

      const wantShape = new Set(record_shape ?? []);
      const perOwner = new Map<number, number>();
      const ownerClassCount = new Map<string, number>();
      let records = 0;
      let recordsWithoutOwner = 0;

      snapshot.nodes.forEach(node => {
        if (record_class != null && node.name !== record_class) return;
        if (wantShape.size > 0) {
          const keys = shapeKeys(node);
          for (const k of wantShape) {
            if (!keys.has(k)) return;
          }
        }
        records++;
        let owner: IHeapNode | null = null;
        for (const e of node.references) {
          if (String(e.name_or_index) === owner_edge) {
            owner = e.toNode;
            break;
          }
        }
        if (!owner) {
          recordsWithoutOwner++;
          return;
        }
        perOwner.set(owner.id, (perOwner.get(owner.id) ?? 0) + 1);
        ownerClassCount.set(
          owner.name,
          (ownerClassCount.get(owner.name) ?? 0) + 1,
        );
      });

      if (records === 0) {
        return toolResult(
          'No records matched. On a minified heap a `record_class` filter usually matches nothing useful — try `record_shape` with the property names from `memlab_shape_histogram` or `memlab_identify`.',
        );
      }

      const inferredOwnerClass =
        owner_class ??
        [...ownerClassCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

      // How many owners of that class are alive, whether or not they hold a
      // record. This is the denominator that makes the ratio mean something.
      let liveOwners = 0;
      if (inferredOwnerClass != null) {
        snapshot.nodes.forEach(node => {
          if (node.name === inferredOwnerClass) liveOwners++;
        });
      }

      const distinctOwners = perOwner.size;
      const ratio = liveOwners > 0 ? records / liveOwners : NaN;
      // A ratio far BELOW 1.0 is not a mild version of "structural" — it means
      // most live owners hold no record at all, which in practice means the
      // filter selected something other than the intended population. Reporting
      // it as STRUCTURAL states the reassuring conclusion ("not a leak") on the
      // strength of a match that did not happen.
      const underMatched = Number.isFinite(ratio) && ratio < 0.5;
      const tooFewRecords = records < 10;
      const internalOwner =
        inferredOwnerClass != null &&
        (inferredOwnerClass.startsWith('system /') ||
          inferredOwnerClass.startsWith('(') ||
          inferredOwnerClass === 'Object');
      const verdict = !Number.isFinite(ratio)
        ? 'UNKNOWN — could not count live owners'
        : underMatched
          ? `UNDER-MATCHED — only ${formatNumber(records)} record(s) against ${formatNumber(liveOwners)} live owner(s), so most owners hold none. Treat this as a filter that missed, NOT as evidence of "not a leak": re-check \`record_shape\`/\`record_class\` against \`memlab_shape_histogram\`, and \`owner_edge\` against \`memlab_object_shape\` on one record.`
          : ratio <= 1.25
            ? 'STRUCTURAL — about one record per live owner. This is a standing O(owners) cost, not accumulation: it scales with user data, not with time. A fix should remove the per-owner cost; do not describe it as a leak.'
            : ratio >= 2
              ? 'ACCUMULATING — owners are holding several records each. Look at the top owners below; that is where the extra records are.'
              : 'BORDERLINE — slightly more than one record per owner. Check the top owners, and confirm against a ladder before calling it either way.';

      const top = [...perOwner.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);

      const out: string[] = [
        `## Population vs owners`,
        '',
        `- Records matched: **${formatNumber(records)}**${record_class ? ` (class \`${record_class}\`)` : ` (shape \`${[...wantShape].join(', ')}\`)`}`,
        `- Distinct owners holding at least one: **${formatNumber(distinctOwners)}** (via \`.${owner_edge}\`)`,
        `- Live owners of class \`${inferredOwnerClass ?? '(unknown)'}\` in the heap: **${formatNumber(liveOwners)}**${owner_class ? '' : ' _(class inferred from the records)_'}`,
        `- **Records per live owner: ${Number.isFinite(ratio) ? ratio.toFixed(2) : 'n/a'}**`,
        '',
        `**${verdict}**`,
      ];
      if (tooFewRecords) {
        out.push(
          '',
          `> ⚠ ${formatNumber(records)} record(s) is too small a population to characterise. Any ratio from it is noise; widen the filter before drawing a conclusion either way.`,
        );
      }
      if (internalOwner) {
        out.push(
          '',
          `> ⚠ The owner class resolved to \`${inferredOwnerClass}\`, which is a V8 internal or a generic container rather than an application object. \`.${owner_edge}\` is almost certainly not the edge that points at the real owner — find the right one with \`memlab_object_shape\` on one record, or pass \`owner_class\` explicitly.`,
        );
      }
      if (recordsWithoutOwner > 0) {
        out.push(
          '',
          `_${formatNumber(recordsWithoutOwner)} record(s) had no \`.${owner_edge}\` edge and are excluded from the ratio. If that is most of them, the owner edge is probably named something else._`,
        );
      }
      if (distinctOwners > liveOwners && liveOwners > 0) {
        out.push(
          '',
          `> ⚠ More distinct owners hold records (${formatNumber(distinctOwners)}) than there are live owners of that class (${formatNumber(liveOwners)}). The surplus owners are unreachable except through these records — that IS an accumulation, and those owners are being kept alive by it.`,
        );
      }
      if (top.length > 0) {
        out.push('', '### Owners holding the most records', '');
        for (const [ownerId, count] of top) {
          const n = snapshot.getNodeById(ownerId);
          out.push(
            `- @${ownerId} \`${n?.name ?? '?'}\` — ${formatNumber(count)} record(s)`,
          );
        }
      }
      out.push(
        '',
        '_One snapshot gives the ratio, not a rate. A structural verdict means "not growing per owner"; it does not mean the owner count itself is bounded. Confirm with `memlab_ladder_probe` if the owner population might be what grows._',
      );
      return toolResult(out.join('\n'));
    },
  );
}
