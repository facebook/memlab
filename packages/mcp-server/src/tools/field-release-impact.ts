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
 * If I null this field, how many bytes actually come back — and is it the only
 * door?
 *
 * This is the question every memory fix asks, and there was no tool for it.
 * `memlab_island_doors` answers it for a detached island; `memlab_what_if`
 * answers it for a set of node ids you already have. Neither answers it for a
 * PROPERTY, which is the form a fix almost always takes: "release
 * `TracedInteraction.vcMutationLog` once the trace is logged".
 *
 * A session writing exactly that fix hand-rolled it in three round trips — one
 * eval to collect the field's targets and aggregate their retained size, a
 * second to histogram `numOfReferrers`, a third to dump the actual referrer
 * edge names to find out whether the second referrer was an independent holder
 * or the owner's own `(object properties)` backing store (it was the backing
 * store: the same reference, seen twice). Fifteen minutes for a question that is
 * the same shape every time.
 *
 * Getting it wrong is expensive in a specific way. A fix that removes one of
 * several holders reclaims nothing, and the re-measurement reads as "the fix
 * does not work" rather than "the fix is incomplete" — one hunt spent four A/B
 * capture cycles that way.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * Edges that are the SAME reference seen a second time, not an independent
 * holder.
 *
 * V8 stores out-of-line properties in an `(object properties)` backing array
 * and array contents in an `(object elements)` store, so a value reachable as
 * `owner.field` is also reachable as `backingStore[slot]`. Counting that as a
 * second door turns every single-door fix into a false "co-retained" verdict —
 * which is worse than no tool, because it talks people out of correct fixes.
 */
function isSelfEdge(fromName: string): boolean {
  return (
    fromName === '(object properties)' ||
    fromName === '(object elements)' ||
    fromName === 'system / PropertyArray'
  );
}

interface Door {
  fromName: string;
  edgeName: string;
  count: number;
}

export function registerFieldReleaseImpact(server: McpServer): void {
  server.tool(
    'memlab_field_release_impact',
    'If a fix nulls this property, how many bytes actually come back — and is the property the ONLY reference?\n\n' +
      'The question every memory fix asks, in the form fixes actually take ("release `TracedInteraction.vcMutationLog` after logging"). `memlab_island_doors` answers it for a detached island and `memlab_what_if` for a set of node ids; neither answers it for a property, so it gets hand-rolled in three evals — collect the targets and aggregate retained size, histogram the referrer counts, then dump referrer edge names to find out whether a second referrer is a real holder or the owner\'s own `(object properties)` backing store.\n\n' +
      'Reports: dominator-deduped retained bytes of the targets (what a release frees), the referrer-count distribution, the distinct independent holders with self-edges filtered out, and a verdict — **SINGLE DOOR** (releasing frees the bytes) or **CO-RETAINED** (releasing frees ~0, and a fix that only removes this one reclaims nothing).\n\n' +
      'Getting this wrong has a signature: the re-measurement reads as "the fix does not work" rather than "the fix is incomplete". One hunt spent four A/B capture cycles that way.',
    {
      property: z
        .string()
        .describe(
          'The property name a fix would null, e.g. "vcMutationLog". Matched exactly against property edge names.',
        ),
      owner_class: z
        .string()
        .optional()
        .describe(
          'Only consider the property on owners of this class. Use when the same name is carried by unrelated objects.',
        ),
      sample_referrers: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(200)
        .describe(
          'How many multi-referrer targets to inspect for independent holders. The count histogram covers ALL of them; only the edge-name breakdown is sampled.',
        ),
    },
    async ({property, owner_class, sample_referrers}) => {
      try {
        const snapshot = getSnapshot();
        if (!snapshot) {
          return errorResult(
            new Error('No heap snapshot loaded. Use memlab_load_snapshot first.'),
          );
        }

        const targets: IHeapNode[] = [];
        let owners = 0;
        snapshot.nodes.forEach((node: IHeapNode) => {
          if (node.type !== 'object') return;
          if (owner_class != null && node.name !== owner_class) return;
          for (const edge of node.references) {
            if (edge.type !== 'property') continue;
            if (edge.name_or_index !== property) continue;
            const t = edge.toNode;
            // A primitive or an oddball costs nothing to release; counting it
            // would inflate the population and dilute the byte figure.
            if (t == null || t.type === 'hidden') continue;
            owners++;
            targets.push(t);
          }
        });

        if (targets.length === 0) {
          return toolResult(
            `## Field release impact — \`${property}\`\n\n` +
              `No object${owner_class != null ? ` of class \`${owner_class}\`` : ''} carries a \`${property}\` property edge in this snapshot.\n\n` +
              '_A miss here is not evidence the field does not exist: a property whose value is a small integer or `null` is stored inline and has no target node, and a value held only in a closure variable is not a property at all. Check `memlab_property_names` for the exact spelling._',
          );
        }

        // Deduplicate by id first — the same array can be the value of the
        // property on several owners.
        const uniqueTargets = new Map<number, IHeapNode>();
        for (const t of targets) uniqueTargets.set(t.id, t);

        let retained = 0;
        for (const t of uniqueTargets.values()) {
          // Only count a target that is not dominated by another target, so a
          // nested pair is charged once.
          let dominatedByPeer = false;
          let d = t.dominatorNode;
          for (let hop = 0; hop < 24 && d != null; hop++) {
            if (uniqueTargets.has(d.id) && d.id !== t.id) {
              dominatedByPeer = true;
              break;
            }
            d = d.dominatorNode;
          }
          if (!dominatedByPeer) retained += t.retainedSize;
        }

        // Referrer-count distribution over ALL targets.
        //
        // One class of target has to be separated out first: V8 interns shared
        // immutables (the empty array, the empty object) and a field whose value
        // is `[]` points at that singleton, which the whole heap also points at.
        // Measured: one target in a 1,772-target population had 375,568
        // referrers, and letting it into the holder analysis produced a table of
        // 25,869 "other holders" and a false CO-RETAINED verdict on a fix that
        // is in fact single-door. A shared singleton is not co-retention; it is
        // a value that costs nothing to release.
        const sharedSingletonFloor = Math.max(1000, uniqueTargets.size * 10);
        const hist = new Map<number, number>();
        const multi: IHeapNode[] = [];
        const sharedSingletons: IHeapNode[] = [];
        for (const t of uniqueTargets.values()) {
          const n = t.numOfReferrers ?? 0;
          if (n >= sharedSingletonFloor) {
            sharedSingletons.push(t);
            continue;
          }
          hist.set(n, (hist.get(n) ?? 0) + 1);
          if (n > 1) multi.push(t);
        }

        // Independent holders, self-edges removed.
        const doors = new Map<string, Door>();
        let inspected = 0;
        let selfEdgesSkipped = 0;
        for (const t of multi) {
          if (inspected >= sample_referrers) break;
          inspected++;
          for (const ref of t.referrers) {
            const fromName = ref.fromNode?.name ?? '(unknown)';
            if (isSelfEdge(fromName)) {
              selfEdgesSkipped++;
              continue;
            }
            const edgeName = String(ref.name_or_index);
            if (edgeName === property) continue; // the door we are closing
            const key = `${fromName} ${edgeName}`;
            const d = doors.get(key);
            if (d) d.count++;
            else doors.set(key, {fromName, edgeName, count: 1});
          }
        }

        const uniqueCount = hist.get(1) ?? 0;
        const total = uniqueTargets.size - sharedSingletons.length;
        const singleDoor = doors.size === 0;

        const lines: string[] = [
          `## Field release impact — \`${property}\``,
          '',
          `**${formatNumber(total)}** distinct target(s) across **${formatNumber(owners)}** owner(s)` +
            (owner_class != null ? ` of class \`${owner_class}\`` : '') +
            (sharedSingletons.length > 0
              ? `, plus ${formatNumber(sharedSingletons.length)} shared immutable singleton(s) excluded (an interned \`[]\`/\`{}\` that the whole heap points at — it costs nothing to release and is not co-retention)`
              : '') +
            '.',
          '',
          `**Releasing \`${property}\` frees ${formatBytes(retained)}** (dominator-deduped across the targets).`,
          '',
          `**Verdict: ${
            singleDoor
              ? 'SINGLE DOOR — nulling this property makes the targets unreachable, so the bytes above are real.'
              : 'CO-RETAINED — the targets have other independent holders, so nulling this property alone frees close to nothing.'
          }**`,
          '',
        ];

        const histRows = [...hist.entries()]
          .sort((a, b) => a[0] - b[0])
          .slice(0, 10)
          .map(([n, c]) => [
            String(n),
            formatNumber(c),
            `${((c / total) * 100).toFixed(1)}%`,
          ]);
        lines.push(
          '### Referrer counts',
          '',
          markdownTable(['Referrers', 'Targets', 'Share'], histRows, new Set([1, 2])),
          '',
        );

        if (doors.size > 0) {
          const rows = [...doors.values()]
            .sort((a, b) => b.count - a.count)
            .slice(0, 15)
            .map(d => [d.fromName, d.edgeName, formatNumber(d.count)]);
          lines.push(
            '### Other holders — each is a reference the fix must also remove',
            '',
            markdownTable(['From', 'Edge', 'Targets'], rows, new Set([2])),
            '',
          );
        } else {
          lines.push(
            `_${formatNumber(uniqueCount)} of ${formatNumber(total)} target(s) have exactly one referrer; ` +
              `the rest resolve to self-edges only (${formatNumber(selfEdgesSkipped)} skipped)._`,
            '',
          );
        }

        lines.push(
          '_Self-edges are filtered: V8 stores out-of-line properties in an `(object properties)` ' +
            'backing array, so a value reachable as `owner.field` is ALSO reachable as ' +
            '`backingStore[slot]`. That is the same reference seen twice, not a second holder, and ' +
            'counting it would talk you out of a correct fix. Verified on a real fix where 1,771 of ' +
            '1,772 targets showed exactly two referrers and both resolved to the same reference._',
        );

        return toolResult(lines.join('\n'));
      } catch (e: unknown) {
        return errorResult(e);
      }
    },
  );
}
