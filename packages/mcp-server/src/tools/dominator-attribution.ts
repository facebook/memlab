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
import memlabCore from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  boundedDominatorRetainedSize,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
  truncateNodeName,
} from '../utils.js';
import {makeMembershipTest, parsePopulation} from './population-diff.js';

const {NumericSet} = memlabCore;

// Bound on the upward walk from a population member to a candidate, mirroring
// `boundedDominatorRetainedSize`. A member whose walk truncates is reported
// unattributed rather than guessed at.
const MAX_HOPS = 500;

interface CandidateStats {
  id: number;
  label: string;
  ownRetained: number;
  // Members whose NEAREST candidate ancestor is this one. Exclusive across
  // candidates, so these add up.
  memberCount: number;
  memberSelf: number;
  memberIds: number[];
  // Members this candidate dominates at ANY depth, including those a nested
  // candidate below it took. NOT exclusive — two nested candidates both count
  // the same member — so it is reported separately and never summed.
  totalCount: number;
  // How many of `totalCount` went to a candidate below this one.
  cededCount: number;
}

export function registerDominatorAttribution(server: McpServer): void {
  server.tool(
    'memlab_dominator_attribution',
    'Given several candidate retainers, measure how much of a population each one actually DOMINATES — i.e. what would really be freed by releasing it. Answers "which of these is the amplifier?" with a number instead of a plausible story. ' +
      'Each population member is walked up the dominator tree to the first candidate above it, so every member is attributed to exactly one candidate and the shares cannot double-count. Members that reach the root without passing any candidate are reported as an explicit unattributed remainder — those are held through paths none of the candidates control. ' +
      'When one candidate sits above another, a second column reports what the outer one dominates at any depth, so an ancestor is never printed as holding nothing merely because a nested candidate took its members. ' +
      'A candidate that comes back with ZERO is the useful result: it refutes a hypothesis that named it. Measured example: for 4,541 detached nodes the split was activeElement 3,675 / activeElementInst 0 / lastSelection 18 / 848 unattributed, which killed the "the React fiber is the amplifier" theory outright. ' +
      'Sizes are dominator-deduped (a nested member is not counted again under its ancestor), so the per-candidate figures are additive.',
    {
      node_ids: z
        .array(z.number())
        .describe(
          'Candidate retainer node ids, from the CURRENT snapshot (ids are per-capture). Typically the objects a hypothesis names — e.g. the ids behind the top rows of memlab_detached_dom group_by:"dominator", or the properties of one suspect object.',
        ),
      population: z
        .string()
        .optional()
        .default('detached')
        .describe(
          'What to attribute: "detached" (default), "class:<ClassName>", "shape:prop1,prop2", or "all" (every node in the heap — expensive, and the totals become the whole heap).',
        ),
      limit: z
        .number()
        .optional()
        .default(30)
        .describe('Maximum candidate rows to print (default 30).'),
    },
    async ({node_ids, population, limit}) => {
      try {
        if (node_ids.length === 0) {
          return errorResult(
            'node_ids is empty — pass the candidate retainers to compare.',
          );
        }
        const snapshot = getSnapshot();

        const candidates = new Map<number, CandidateStats>();
        const missing: number[] = [];
        for (const id of node_ids) {
          const node = snapshot.getNodeById(id);
          if (!node) {
            missing.push(id);
            continue;
          }
          candidates.set(id, {
            id,
            label: truncateNodeName(node.name, node.type, node.self_size, 48),
            ownRetained: node.retainedSize,
            memberCount: 0,
            memberSelf: 0,
            memberIds: [],
            totalCount: 0,
            cededCount: 0,
          });
        }
        if (candidates.size === 0) {
          return errorResult(
            `None of the ${node_ids.length} node id(s) exist in the current snapshot (ids are only valid within the snapshot they were read from): ${missing.join(', ')}.`,
          );
        }

        const isMember =
          population.trim() === 'all'
            ? (node: IHeapNode) => node.id > 3
            : makeMembershipTest(parsePopulation(population));

        let total = 0;
        let totalSelf = 0;
        let unattributed = 0;
        let unattributedSelf = 0;
        let truncatedWalks = 0;

        snapshot.nodes.forEach(node => {
          if (!isMember(node)) return;
          total++;
          totalSelf += node.self_size;
          // A candidate that is itself in the population is attributed to
          // itself: it dominates itself, and excluding it would understate a
          // container that IS part of what leaked.
          let cur: IHeapNode | null = candidates.has(node.id)
            ? node
            : (node.dominatorNode ?? null);
          let hops = 0;
          let hit: CandidateStats | undefined;
          // The walk does NOT stop at the first candidate. Stopping there
          // reports an ancestor candidate as dominating nothing whenever a
          // second candidate happens to sit between it and the members — which
          // reads as "this object holds none of the leak" when the truth is the
          // opposite. Nearest-wins still decides the exclusive attribution; the
          // rest of the chain is recorded as containment.
          while (cur) {
            const c = candidates.get(cur.id);
            if (c) {
              c.totalCount++;
              if (hit === undefined) hit = c;
              else c.cededCount++;
            }
            if (hops++ >= MAX_HOPS) {
              if (hit === undefined) truncatedWalks++;
              break;
            }
            const next: IHeapNode | null = cur.dominatorNode ?? null;
            if (!next || next.id === cur.id) break;
            cur = next;
          }
          if (hit) {
            hit.memberCount++;
            hit.memberSelf += node.self_size;
            hit.memberIds.push(node.id);
          } else {
            unattributed++;
            unattributedSelf += node.self_size;
          }
        });

        if (total === 0) {
          return toolResult(
            `No nodes match population \`${population}\` in this snapshot — nothing to attribute.`,
          );
        }

        const rows = [...candidates.values()].sort(
          (a, b) =>
            b.memberCount - a.memberCount || b.totalCount - a.totalCount,
        );
        const shown = rows.slice(0, limit);
        const reclaimable = new Map<
          number,
          {retained: number; exact: boolean}
        >();
        for (const c of shown) {
          reclaimable.set(
            c.id,
            c.memberIds.length > 0
              ? boundedDominatorRetainedSize(
                  new NumericSet(c.memberIds),
                  snapshot,
                )
              : {retained: 0, exact: true},
          );
        }

        const pct = (n: number): string =>
          total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '-';

        const lines: string[] = [
          `## Dominator attribution of \`${population}\` across ${formatNumber(candidates.size)} candidate(s)`,
          '',
          `Population: ${formatNumber(total)} node(s), ${formatBytes(totalSelf)} self size.`,
          '',
          markdownTable(
            [
              'Candidate',
              'Class',
              'Attributed',
              '% of pop.',
              'Dominates (any depth)',
              'Reclaimable (deduped)',
              'Candidate retains',
            ],
            shown.map(c => {
              const r = reclaimable.get(c.id);
              return [
                `@${c.id}`,
                c.label,
                formatNumber(c.memberCount),
                pct(c.memberCount),
                c.cededCount > 0
                  ? `${formatNumber(c.totalCount)} (${formatNumber(c.cededCount)} to a nested candidate)`
                  : formatNumber(c.totalCount),
                c.memberCount === 0
                  ? '—'
                  : `${formatBytes(r?.retained ?? 0)}${r?.exact === false ? ' (upper bound)' : ''}`,
                formatBytes(c.ownRetained),
              ];
            }),
            new Set([2, 3, 4, 5, 6]),
          ),
          '',
          `- **Unattributed:** ${formatNumber(unattributed)} (${pct(unattributed)}), ${formatBytes(unattributedSelf)} self — reached the root without passing any candidate, so no candidate here frees them.`,
        ];
        if (rows.length > shown.length) {
          lines.push(
            `- ${formatNumber(rows.length - shown.length)} further candidate(s) not shown (raise \`limit\`).`,
          );
        }
        if (truncatedWalks > 0) {
          lines.push(
            `- ⚠ ${formatNumber(truncatedWalks)} member(s) hit the ${MAX_HOPS}-hop walk cap and were counted as unattributed. Their true owner may be a candidate deeper up the chain; treat the unattributed figure as an upper bound.`,
          );
        }

        const zero = shown.filter(c => c.totalCount === 0);
        if (zero.length > 0) {
          lines.push(
            '',
            `⛔ **${formatNumber(zero.length)} candidate(s) dominate NOTHING in this population, at any depth** (${zero.map(c => `@${c.id} ${c.label}`).join(', ')}). Releasing them frees none of it — any hypothesis that names one of them as the amplifier is refuted by this measurement, not merely unsupported.`,
          );
        }
        const nested = shown.filter(c => c.cededCount > 0);
        if (nested.length > 0) {
          lines.push(
            '',
            `ℹ ${formatNumber(nested.length)} candidate(s) are ANCESTORS of another candidate (${nested.map(c => `@${c.id}`).join(', ')}), so members below the inner one are attributed there. Read their **Attributed** column as "what this object holds that the nested candidate does not" — a low value there with a high **Dominates** does not mean the object is innocent, it means the nested candidate is the tighter fix.`,
          );
        }
        lines.push(
          '',
          "_**Attributed** is by NEAREST candidate in the dominator tree, so each member counts once and the column sums to the population minus the unattributed remainder. **Dominates (any depth)** counts every member below the candidate and therefore double-counts across nested candidates — never sum it. **Reclaimable** is dominator-deduped over the attributed members — the bytes actually released — while **Candidate retains** is the candidate's entire retained size, which also covers everything it holds outside this population._",
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
