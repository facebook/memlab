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
import {getSnapshot, shouldEmitNote} from '../heap-state.js';
import {
  errorResult,
  toolResult,
  formatBytes,
  formatNumber,
  markdownTable,
  suggestionsSuppressed,
  nearestNamedOwner,
} from '../utils.js';
// Shared with memlab_cache_analysis on purpose: a pre-sized ring buffer is the
// one shape that is indistinguishable from an unbounded cache by size alone,
// and a second copy of that heuristic would drift from the first.
import {looksLikeRingBuffer} from './cache-analysis.js';
// The elements-store facts live in one module so cost_breakdown, this tool and
// `helpers.elements` cannot disagree about the same object's capacity.
import {
  STORE_HEADER_BYTES,
  FORGIVEN_TAIL_SLOTS,
  getElementsIndex,
} from '../heap-shapes.js';

interface Group {
  key: string;
  /**
   * `mixed` when the group spans classes. Reporting the first instance's class
   * for the whole group asserts a uniformity nothing checked — one group here
   * reads `Array` in one capture and `Object` in another for the same members.
   */
  className: string;
  count: number;
  capacity: number;
  used: number;
  /** Interior holes: written keys are sparse within their own span. */
  holeSlots: number;
  /** Tail slack past the last written key, minus the forgiven growth floor. */
  slackSlots: number;
  exampleId: number;
  exampleCapacity: number;
  exampleUsed: number;
  exampleSpan: number;
  /**
   * The owner looks like a fixed-capacity ring buffer, so its empty slots are
   * intentional. Kept in the report rather than filtered out — an oversized
   * ring is still worth seeing — but never described as something to trim.
   */
  ring: boolean;
}

/** What a reader should DO about the group, from which half of the waste dominates. */
function diagnose(group: Group): string {
  if (group.ring) {
    return 'PRE-SIZED RING BUFFER — the owner carries a write cursor and/or a capacity control, so the empty slots are the design, not a leak; the question is whether the configured capacity is right, not whether to trim it';
  }
  const hole = group.holeSlots;
  const slack = group.slackSlots;
  if (hole > slack * 2) {
    return 'sparse keys — the written indices are strided or scattered, so the store is sized for a range it never fills; re-key densely (or use a Map)';
  }
  if (slack > hole * 2) {
    return group.used === 0
      ? 'allocated but never filled — the store is sized and then left empty'
      : 'over-allocated — capacity far exceeds the highest key written; presize to the real length';
  }
  return 'both sparse keys and excess capacity';
}

export function registerSparseElements(server: McpServer): void {
  server.tool(
    'memlab_sparse_elements',
    'Find integer-keyed objects and arrays whose ELEMENTS BACKING STORE is mostly holes — memory V8 has allocated and the application never uses. This is the waste a class histogram cannot see: the store is a `(object elements)` FixedArray charged to no class, and each instance is individually small, so the cost only appears once instances are grouped by owner. Two distinct causes are separated in the output: sparse/strided keys (indices scattered across a range the store must span) and over-allocation (capacity far past the highest key). Groups are labelled by the nearest named property up the retainer chain (`getterImpl.$$cache`), which is what you can grep for. Complements memlab_cache_analysis (entry counts in Maps/Sets) and memlab_object_cost_breakdown (where one class’s bytes go).',
    {
      min_capacity: z
        .number()
        .optional()
        .default(32)
        .describe(
          'Ignore backing stores smaller than this many slots (default 32). Below it, V8’s own growth floor dominates and every short array looks empty.',
        ),
      max_occupancy: z
        .number()
        .optional()
        .default(0.5)
        .describe(
          'Only count an instance when at most this fraction of its slots hold a value (default 0.5). Raise toward 1 to include stores that are merely over-allocated.',
        ),
      min_group_bytes: z
        .number()
        .optional()
        .default(4096)
        .describe(
          'Drop groups wasting less than this many bytes in total (default 4096).',
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of groups to report (default 20).'),
      max_hops: z
        .number()
        .optional()
        .default(6)
        .describe(
          'How far up the retainer chain to look for a named owner before giving up and grouping as unattributed (default 6).',
        ),
    },
    async ({min_capacity, max_occupancy, min_group_bytes, limit, max_hops}) => {
      try {
        const snapshot = getSnapshot();

        // The structural pass is memoized per snapshot (see heap-shapes.ts):
        // repeated calls while tuning min_capacity / max_occupancy — the normal
        // way this tool is used — cost one full walk, not one per call.
        const index = getElementsIndex(snapshot);
        const slotBytes = index.slotBytes;

        const groups = new Map<string, Group>();
        let unmeasurable = 0;
        let unmeasurableBytes = 0;
        let dictionaries = 0;
        let examined = 0;

        for (let i = 0; i < index.count; i++) {
          const storeBytes = index.storeBytes[i];
          const rawUsed = index.used[i];
          const capacity = Math.floor(
            (storeBytes - STORE_HEADER_BYTES) / slotBytes,
          );
          const span = index.maxIndex[i] + 1;
          if (span > capacity) {
            // Keys reach past the dense capacity: this is a NumberDictionary,
            // where a hole costs nothing and "waste" is not defined.
            dictionaries++;
            continue;
          }
          if (capacity < min_capacity) continue;
          examined++;
          if (rawUsed === 0) {
            unmeasurable++;
            unmeasurableBytes += storeBytes;
            continue;
          }
          if (rawUsed / capacity > max_occupancy) continue;

          const holeSlots = span - rawUsed;
          const slackSlots = Math.max(0, capacity - span - FORGIVEN_TAIL_SLOTS);
          if (holeSlots + slackSlots === 0) continue;

          // Resolving the node is deferred to here on purpose: attribution is
          // the expensive part and only the survivors of the filters need it.
          const node = snapshot.getNodeById(index.ownerIds[i]);
          if (node == null) continue;
          const attributed = nearestNamedOwner(node, {maxHops: max_hops});
          const key = attributed
            ? attributed.label
            : `(unattributed) ${node.name}`;
          let group = groups.get(key);
          if (!group) {
            group = {
              key,
              className: node.name,
              count: 0,
              capacity: 0,
              used: 0,
              holeSlots: 0,
              slackSlots: 0,
              exampleId: node.id,
              exampleCapacity: capacity,
              exampleUsed: rawUsed,
              exampleSpan: span,
              ring: looksLikeRingBuffer(attributed?.ownerNode ?? null),
            };
            groups.set(key, group);
          }
          if (group.className !== node.name) group.className = 'mixed';
          group.count++;
          group.capacity += capacity;
          group.used += rawUsed;
          group.holeSlots += holeSlots;
          group.slackSlots += slackSlots;
          // Keep the worst instance as the example so a follow-up trace lands
          // on a representative object rather than the first one scanned.
          const waste = holeSlots + slackSlots;
          const exampleWaste =
            group.exampleSpan -
            group.exampleUsed +
            Math.max(
              0,
              group.exampleCapacity - group.exampleSpan - FORGIVEN_TAIL_SLOTS,
            );
          if (waste > exampleWaste) {
            group.exampleId = node.id;
            group.exampleCapacity = capacity;
            group.exampleUsed = rawUsed;
            group.exampleSpan = span;
          }
        }

        const ranked = [...groups.values()]
          .map(g => ({g, waste: (g.holeSlots + g.slackSlots) * slotBytes}))
          .filter(r => r.waste >= min_group_bytes)
          .sort((a, b) => b.waste - a.waste);
        const dropped = groups.size - ranked.length;
        const shown = ranked.slice(0, limit);
        const totalWaste = ranked.reduce((sum, r) => sum + r.waste, 0);

        const lines: string[] = [
          '## Sparse elements backing stores',
          '',
          `Scanned ${formatNumber(index.count)} objects with an elements store; ${formatNumber(examined)} were dense and at least ${formatNumber(min_capacity)} slots. Slot width calibrated to **${slotBytes} bytes** (${slotBytes === 4 ? 'pointer-compressed' : 'uncompressed'} heap).`,
          '',
        ];

        if (shown.length === 0) {
          lines.push(
            `No group wastes ${formatBytes(min_group_bytes)} or more. Lower \`min_group_bytes\`, raise \`max_occupancy\`, or lower \`min_capacity\` to widen the scan.`,
          );
        } else {
          lines.push(
            `**${formatBytes(totalWaste)}** of unused slots across ${formatNumber(ranked.length)} owner group(s)${dropped > 0 ? `; ${formatNumber(dropped)} smaller group(s) below the ${formatBytes(min_group_bytes)} floor were dropped` : ''}.`,
            '',
            markdownTable(
              [
                'Owner',
                'Class',
                'Count',
                'Slots used / cap',
                'Holes',
                'Slack',
                'Wasted',
              ],
              shown.map(({g, waste}) => [
                g.ring ? `${g.key} (ring)` : g.key,
                g.className,
                formatNumber(g.count),
                `${formatNumber(g.used)} / ${formatNumber(g.capacity)} (${Math.round((g.used / g.capacity) * 100)}%)`,
                formatBytes(g.holeSlots * slotBytes),
                formatBytes(g.slackSlots * slotBytes),
                formatBytes(waste),
              ]),
              new Set([2, 3, 4, 5, 6]),
            ),
            '',
            '### What to do about each',
            '',
          );
          for (const {g, waste} of shown) {
            lines.push(
              `- **${g.key}** — ${formatBytes(waste)} across ${formatNumber(g.count)} instance(s). ${diagnose(g)}. Worst example \`@${g.exampleId}\`: ${formatNumber(g.exampleUsed)} value(s) spread over ${formatNumber(g.exampleSpan)} slot(s) in a ${formatNumber(g.exampleCapacity)}-slot store.`,
            );
          }
        }

        // The per-call NUMBERS stay; the standing EXPLANATION of what
        // "unmeasurable" and "dictionary-mode" mean is the same paragraph every
        // call and is a third of this tool's output. Printed in full once per
        // session, then pointed at (memlab_snapshots({repeat_notes:true})
        // brings it back).
        const longCaveats = shouldEmitNote('sparse-elements:caveats');
        lines.push(
          '',
          '### Coverage and caveats',
          '',
          longCaveats
            ? `- ${formatNumber(unmeasurable)} store(s) holding ${formatBytes(unmeasurableBytes)} were skipped as UNMEASURABLE: a slot holding a small integer emits no edge a snapshot can see, so an array of numbers and an array of holes are indistinguishable. Anything storing only numbers is therefore invisible to this tool — not absent from it.`
            : `- UNMEASURABLE (all-SMI or all-hole): ${formatNumber(unmeasurable)} store(s), ${formatBytes(unmeasurableBytes)}.`,
          longCaveats
            ? `- ${formatNumber(dictionaries)} store(s) were dictionary-mode (keys past the dense capacity), where holes cost nothing and are correctly not reported.`
            : `- Dictionary-mode (excluded): ${formatNumber(dictionaries)} store(s).`,
          ...(longCaveats
            ? [
                `- Occupancy is a LOWER bound and waste an UPPER bound for the same reason: a store mixing numbers and objects reads as emptier than it is.`,
                `- Up to ${formatNumber(FORGIVEN_TAIL_SLOTS)} tail slots per instance are forgiven — that is V8’s minimum growth increment, not something the application can give back.`,
              ]
            : [
                `- Occupancy is a lower bound; ${formatNumber(FORGIVEN_TAIL_SLOTS)} tail slots per instance are forgiven. _(Full explanation printed once per session — memlab_snapshots({repeat_notes: true}) to see it again.)_`,
              ]),
        );

        if (
          !suggestionsSuppressed('memlab_sparse_elements') &&
          shown.length > 0
        ) {
          lines.push(
            '',
            '**Suggested next steps**',
            `- \`memlab_retainer_trace({node_id: ${shown[0].g.exampleId}})\` — confirm the owner label against the real path.`,
            `- \`memlab_get_references({node_id: ${shown[0].g.exampleId}})\` — read the actual key layout that produced the holes.`,
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
