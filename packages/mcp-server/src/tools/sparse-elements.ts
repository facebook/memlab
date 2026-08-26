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
import {
  errorResult,
  toolResult,
  formatBytes,
  formatNumber,
  markdownTable,
  suggestionsSuppressed,
} from '../utils.js';
// Shared with memlab_cache_analysis on purpose: a pre-sized ring buffer is the
// one shape that is indistinguishable from an unbounded cache by size alone,
// and a second copy of that heuristic would drift from the first.
import {looksLikeRingBuffer} from './cache-analysis.js';

/**
 * Bytes of the FixedArray header that precede the first slot. Same on a
 * pointer-compressed and an uncompressed heap (map + length), so only the slot
 * width has to be calibrated.
 */
const STORE_HEADER_BYTES = 8;

/**
 * V8 grows an elements backing store to `n + (n >> 1) + kMinAddedElementsCapacity`
 * with `kMinAddedElementsCapacity == 16`, so EVERY array that was built by
 * `push` carries up to 16 slots of tail slack no application change can remove.
 * Charging it as waste turns a one-element array into a "94% empty" finding and
 * buries the real ones, so it is forgiven per instance.
 *
 * https://github.com/v8/v8/blob/main/src/objects/js-objects.h — JSObject::kMinAddedElementsCapacity
 */
const FORGIVEN_TAIL_SLOTS = 16;

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

/**
 * Read a node's elements backing store plus the occupancy of that store.
 *
 * Occupancy has to be read from BOTH ends because V8's snapshot writer splits
 * it: a plain `Object` with integer keys emits an `element` edge per non-hole
 * slot on the owner (SMI values included, pointing at a shared `smi number`
 * node), while a `JSArray` frequently emits nothing on the owner and instead
 * emits `internal` numeric edges on the store — but only for slots holding a
 * heap object, so an all-SMI array looks empty from there. Neither side alone
 * is the occupancy; the owner's set is a superset of the store's whenever both
 * are non-empty, so the max is exact in every shape observed.
 *
 * When both are zero the occupancy is genuinely UNKNOWABLE from the snapshot
 * (an array of 34 timestamps and a `new Array(34)` of holes are byte-identical
 * here). Those are reported as a separate unmeasurable count rather than as
 * 100%-wasted findings — an earlier revision of this scan ranked 4,301
 * all-SMI `Trie._indices` arrays as its second-largest finding.
 */
function readElements(
  node: IHeapNode,
): {store: IHeapNode; used: number; maxIndex: number} | null {
  let store: IHeapNode | null = null;
  let ownerSlots = 0;
  let maxIndex = -1;
  for (const edge of node.references) {
    if (edge.type === 'element') {
      ownerSlots++;
      const index = Number(edge.name_or_index);
      if (index > maxIndex) maxIndex = index;
    } else if (
      edge.type === 'internal' &&
      String(edge.name_or_index) === 'elements'
    ) {
      store = edge.toNode;
    }
  }
  if (!store) return null;
  let storeSlots = 0;
  for (const edge of store.references) {
    const name = String(edge.name_or_index);
    // Numeric edge names on the store are slot indices; `map` and friends are
    // header fields, not contents.
    if (!/^\d+$/.test(name)) continue;
    storeSlots++;
    const index = Number(name);
    if (index > maxIndex) maxIndex = index;
  }
  return {store, used: Math.max(ownerSlots, storeSlots), maxIndex};
}

/**
 * Describe how the store's owner hangs off the anchor, from the edge that
 * points AT it. `null` means the anchor is the object itself.
 *
 * Without this the label lies for 40% of candidates. Measured on one 432 MB
 * capture: of 3,009 candidate stores only 1,815 hang directly off a named
 * property; 1,084 are entries inside a Map or array and 105 are variables
 * captured in a closure. `Owner.prop` reads as "the store IS Owner.prop" in all
 * three cases, and for the closure ones it also DISCARDS the local name — which
 * is the single most greppable thing about them (`EMOJI_LIST`, `fbTop50Emojis`,
 * `specialTags` were all reported as an unrelated sibling's property name).
 */
function describeRelation(edge: {
  type: string;
  name_or_index: string | number;
}): string | null {
  const name = String(edge.name_or_index);
  if (edge.type === 'property' && !/^\d+$/.test(name)) return null;
  // A captured variable keeps its source name even after minification.
  if (edge.type === 'context') return `closure var ${name}`;
  if (/^\d+$/.test(name)) return 'entry';
  return name;
}

/**
 * Walk up referrers to the nearest owner reachable by a NAMED property and
 * label the group `Owner.prop`, plus how the store sits under it.
 *
 * Grouping by the immediate referrer edge does not work: the getter caches that
 * motivated this tool hang off a `Map`, so their referrer edge is the numeric
 * slot index in the map's backing table and 552 identical objects fragment into
 * 552 groups of one. Grouping by class name does not work either — they are all
 * called `Object`. The nearest named property up the chain is what a reader can
 * actually search the codebase for; the relation suffix keeps that anchor from
 * being read as the store's own address.
 */
function attributeOwner(
  node: IHeapNode,
  maxHops: number,
): {label: string; owner: IHeapNode} | null {
  let relation: string | null = null;
  let current = node;
  for (let hop = 0; hop < maxHops; hop++) {
    // A named property wins over any other referrer at the same hop: it is the
    // only edge that names the object rather than merely containing it.
    let chosen = null;
    for (const edge of current.referrers) {
      const name = String(edge.name_or_index);
      if (edge.type === 'property' && !/^\d+$/.test(name)) {
        chosen = edge;
        break;
      }
      if (!chosen) chosen = edge;
    }
    if (!chosen) return null;
    // Only the FIRST hop describes how the store itself is held; hops above it
    // are the anchor's own retention and not the caller's concern.
    if (hop === 0) relation = describeRelation(chosen);
    const name = String(chosen.name_or_index);
    if (chosen.type === 'property' && !/^\d+$/.test(name)) {
      const anchor = `${chosen.fromNode.name}.${name}`;
      return {
        label: relation == null ? anchor : `${anchor} ▸ ${relation}`,
        owner: chosen.fromNode,
      };
    }
    current = chosen.fromNode;
  }
  return null;
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

        // Pass 1: collect every node that owns an elements store, recording the
        // raw store size so the slot width can be calibrated before any
        // capacity is derived from it.
        interface Raw {
          node: IHeapNode;
          storeBytes: number;
          used: number;
          maxIndex: number;
        }
        const raws: Raw[] = [];
        snapshot.nodes.forEach(node => {
          if (
            node.type !== 'object' &&
            node.type !== 'array' &&
            node.type !== 'hidden'
          ) {
            return;
          }
          const read = readElements(node);
          if (!read) return;
          const storeBytes = read.store.self_size;
          if (storeBytes <= STORE_HEADER_BYTES) return;
          raws.push({
            node,
            storeBytes,
            used: read.used,
            maxIndex: read.maxIndex,
          });
        });

        // Slot width: 4 bytes under pointer compression (every browser heap,
        // and Node below the 4 GB cage), 8 otherwise. Getting it wrong by 2x
        // either invents slack that does not exist or classifies every dense
        // store as a dictionary, so it is measured rather than assumed. A store
        // whose largest written index fits in `(size - 8) / 4` slots but NOT in
        // `(size - 8) / 8` can only be 4-byte-slotted; dictionary-mode stores
        // overflow both, so they cannot fake the signal.
        let onlyAt4 = 0;
        for (const raw of raws) {
          const slots = raw.maxIndex + 1;
          if (slots <= 0) continue;
          const at8 = (raw.storeBytes - STORE_HEADER_BYTES) / 8;
          const at4 = (raw.storeBytes - STORE_HEADER_BYTES) / 4;
          if (slots > at8 && slots <= at4) onlyAt4++;
        }
        // Default to 4: every browser capture is pointer-compressed, and a heap
        // with too few dense stores to calibrate from is also one where the
        // difference cannot change any ranking.
        const slotBytes = onlyAt4 > 0 ? 4 : 8;

        const groups = new Map<string, Group>();
        let unmeasurable = 0;
        let unmeasurableBytes = 0;
        let dictionaries = 0;
        let examined = 0;

        for (const raw of raws) {
          const capacity = Math.floor(
            (raw.storeBytes - STORE_HEADER_BYTES) / slotBytes,
          );
          const span = raw.maxIndex + 1;
          if (span > capacity) {
            // Keys reach past the dense capacity: this is a NumberDictionary,
            // where a hole costs nothing and "waste" is not defined.
            dictionaries++;
            continue;
          }
          if (capacity < min_capacity) continue;
          examined++;
          if (raw.used === 0) {
            unmeasurable++;
            unmeasurableBytes += raw.storeBytes;
            continue;
          }
          if (raw.used / capacity > max_occupancy) continue;

          const holeSlots = span - raw.used;
          const slackSlots = Math.max(0, capacity - span - FORGIVEN_TAIL_SLOTS);
          if (holeSlots + slackSlots === 0) continue;

          const attributed = attributeOwner(raw.node, max_hops);
          const key = attributed
            ? attributed.label
            : `(unattributed) ${raw.node.name}`;
          let group = groups.get(key);
          if (!group) {
            group = {
              key,
              className: raw.node.name,
              count: 0,
              capacity: 0,
              used: 0,
              holeSlots: 0,
              slackSlots: 0,
              exampleId: raw.node.id,
              exampleCapacity: capacity,
              exampleUsed: raw.used,
              exampleSpan: span,
              ring: looksLikeRingBuffer(attributed?.owner ?? null),
            };
            groups.set(key, group);
          }
          if (group.className !== raw.node.name) group.className = 'mixed';
          group.count++;
          group.capacity += capacity;
          group.used += raw.used;
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
            group.exampleId = raw.node.id;
            group.exampleCapacity = capacity;
            group.exampleUsed = raw.used;
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
          `Scanned ${formatNumber(raws.length)} objects with an elements store; ${formatNumber(examined)} were dense and at least ${formatNumber(min_capacity)} slots. Slot width calibrated to **${slotBytes} bytes** (${slotBytes === 4 ? 'pointer-compressed' : 'uncompressed'} heap).`,
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

        lines.push(
          '',
          '### Coverage and caveats',
          '',
          `- ${formatNumber(unmeasurable)} store(s) holding ${formatBytes(unmeasurableBytes)} were skipped as UNMEASURABLE: a slot holding a small integer emits no edge a snapshot can see, so an array of numbers and an array of holes are indistinguishable. Anything storing only numbers is therefore invisible to this tool — not absent from it.`,
          `- ${formatNumber(dictionaries)} store(s) were dictionary-mode (keys past the dense capacity), where holes cost nothing and are correctly not reported.`,
          `- Occupancy is a LOWER bound and waste an UPPER bound for the same reason: a store mixing numbers and objects reads as emptier than it is.`,
          `- Up to ${formatNumber(FORGIVEN_TAIL_SLOTS)} tail slots per instance are forgiven — that is V8’s minimum growth increment, not something the application can give back.`,
        );

        if (!suggestionsSuppressed() && shown.length > 0) {
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
