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
import {getSnapshot} from '../heap-state.js';
import {
  getElementsIndex,
  STORE_HEADER_BYTES,
  FORGIVEN_TAIL_SLOTS,
} from '../heap-shapes.js';
import {
  errorResult,
  toolResult,
  formatBytes,
  formatNumber,
  markdownTable,
  nearestNamedOwner,
  suggestionsSuppressed,
} from '../utils.js';

/** Upper bound on keys read per structure before they are sampled down. */
const MAX_KEYS_READ = 8192;

/** Keys kept per structure for comparison, sampled evenly across the range. */
const MAX_KEYS_PER_STRUCTURE = 512;

/**
 * Reduce a key set to the keys that carry information about the ALLOCATOR.
 *
 * The first version of this compared raw key sets and clustered 395 unrelated
 * structures into one, because every array on earth contains 0, 1, 2, 3 — a
 * densely packed array of length L has exactly the keys 0..L-1, so it overlaps
 * heavily with every other array and the similarity score means nothing.
 *
 * A key is informative only when it is LARGER than the number of keys written,
 * which is precisely the condition "this index came from somewhere other than a
 * running counter local to this structure". A dense array contributes nothing
 * and drops out; a table subscripted by a global id keeps almost all of its
 * keys.
 */
function sparseSignature(keys: number[], used: number): number[] {
  const floor = Math.max(used, keys.length);
  return keys.filter(k => k >= floor);
}

/** Evenly spaced sample, so a prefix cannot bias the comparison toward low ids. */
function sampleEvenly(keys: number[], n: number): number[] {
  if (keys.length <= n) return keys;
  const out: number[] = [];
  const stride = keys.length / n;
  for (let i = 0; i < n; i++) out.push(keys[Math.floor(i * stride)]);
  return out;
}

interface Structure {
  nodeId: number;
  label: string;
  keys: number[];
  keySet: Set<number>;
  capacity: number;
  used: number;
  wasteSlots: number;
}

/** |A ∩ B| / |A ∪ B| over the sampled key sets. */
function jaccard(a: Set<number>, b: Set<number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const k of small) if (large.has(k)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

export function registerIdSpaceAudit(server: McpServer): void {
  server.tool(
    'memlab_id_space_audit',
    'Find SEPARATE integer-keyed structures that are indexed by the SAME sparse id space. One global counter handed out as an array index leaves every table that uses it sized for the whole id range and mostly holes — and each table looks like an isolated small finding until they are clustered. On one capture three separately-reported groups (a name table, a ref array and a placeholder map) all wrote keys 191 and 212 among others: one design problem, one re-keying fix, reported as three unrelated rows. Clusters by key-set similarity (Jaccard over sampled indices) and reports the combined waste per cluster, which is the number a fix is worth. Complements memlab_sparse_elements, which finds the individual sparse stores but cannot see that several share an allocator.',
    {
      min_keys: z
        .number()
        .optional()
        .default(4)
        .describe(
          'Ignore structures with fewer than this many SPARSE keys (default 4) — a key counts only when it is larger than the number of keys written, since a densely packed array has keys 0..N-1 by construction and overlaps with everything.',
        ),
      min_similarity: z
        .number()
        .optional()
        .default(0.25)
        .describe(
          'Jaccard threshold for two structures to join a cluster (default 0.25). Lower it to catch tables that use disjoint ranges of one counter; raise it to demand near-identical key sets.',
        ),
      min_cluster_waste: z
        .number()
        .optional()
        .default(4096)
        .describe(
          'Drop clusters whose combined unused capacity is below this many bytes (default 4096).',
        ),
      max_structures: z
        .number()
        .optional()
        .default(400)
        .describe(
          'Cap on how many sparse structures are compared (default 400). Comparison is pairwise, so this bounds the cost at O(n²) on the LARGEST structures — the ones a shared id space would actually cost something in.',
        ),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe('Maximum clusters to report (default 10).'),
    },
    async ({
      min_keys,
      min_similarity,
      min_cluster_waste,
      max_structures,
      limit,
    }) => {
      try {
        const snapshot = getSnapshot();
        const index = getElementsIndex(snapshot);
        const slotBytes = index.slotBytes;

        // Only SPARSE structures can share a sparse id space, and only the
        // biggest ones matter — so rank by waste before paying for key reads.
        const candidates: Array<{i: number; waste: number}> = [];
        for (let i = 0; i < index.count; i++) {
          const capacity = Math.floor(
            (index.storeBytes[i] - STORE_HEADER_BYTES) / slotBytes,
          );
          const span = index.maxIndex[i] + 1;
          if (span > capacity) continue; // dictionary
          const used = index.used[i];
          if (used < min_keys) continue;
          if (used / capacity > 0.6) continue;
          const waste =
            span - used + Math.max(0, capacity - span - FORGIVEN_TAIL_SLOTS);
          if (waste <= 0) continue;
          candidates.push({i, waste});
        }
        candidates.sort((a, b) => b.waste - a.waste);
        const picked = candidates.slice(0, max_structures);

        const structures: Structure[] = [];
        for (const {i, waste} of picked) {
          const node = snapshot.getNodeById(index.ownerIds[i]);
          if (node == null) continue;
          const keys: number[] = [];
          for (const edge of node.references) {
            if (edge.type !== 'element') continue;
            if (keys.length >= MAX_KEYS_READ) break;
            keys.push(Number(edge.name_or_index));
          }
          if (keys.length === 0) {
            // JSArray shape: the indices live on the store, not the owner.
            const store = snapshot.getNodeById(
              // The store is not in the index; re-read it from the owner.
              node.references.find(
                e =>
                  e.type === 'internal' &&
                  String(e.name_or_index) === 'elements',
              )?.toNode.id ?? -1,
            );
            if (store != null) {
              for (const edge of store.references) {
                const name = String(edge.name_or_index);
                if (!/^\d+$/.test(name)) continue;
                if (keys.length >= MAX_KEYS_READ) break;
                keys.push(Number(name));
              }
            }
          }
          // Only the keys that say something about the allocator.
          const signature = sampleEvenly(
            sparseSignature(keys, index.used[i]),
            MAX_KEYS_PER_STRUCTURE,
          );
          if (signature.length < min_keys) continue;
          const capacity = Math.floor(
            (index.storeBytes[i] - STORE_HEADER_BYTES) / slotBytes,
          );
          structures.push({
            nodeId: node.id,
            label:
              nearestNamedOwner(node, {maxHops: 6})?.label ??
              `(unattributed) ${node.name}`,
            keys: signature,
            keySet: new Set(signature),
            capacity,
            used: index.used[i],
            wasteSlots: waste,
          });
        }

        if (structures.length < 2) {
          return toolResult(
            `Only ${formatNumber(structures.length)} structure(s) had at least ${formatNumber(min_keys)} keys larger than their own key count, so there is nothing to cluster. A densely packed array contributes no evidence about an allocator — its keys are 0..N-1 by construction.\n\n` +
              'Note that a structure holding only small integers is invisible here — a snapshot cannot distinguish an all-SMI array from an all-hole one. Run `memlab_sparse_elements` for the per-structure view.',
          );
        }

        // Union-find over the similarity graph: a shared allocator can show up
        // as a chain (A~B, B~C) even when A and C use disjoint ranges of it.
        const parent = structures.map((_, i) => i);
        const find = (x: number): number => {
          let r = x;
          while (parent[r] !== r) r = parent[r];
          while (parent[x] !== r) {
            const next = parent[x];
            parent[x] = r;
            x = next;
          }
          return r;
        };
        const union = (a: number, b: number): void => {
          const ra = find(a);
          const rb = find(b);
          if (ra !== rb) parent[rb] = ra;
        };
        for (let a = 0; a < structures.length; a++) {
          for (let b = a + 1; b < structures.length; b++) {
            if (
              jaccard(structures[a].keySet, structures[b].keySet) >=
              min_similarity
            ) {
              union(a, b);
            }
          }
        }

        const clusters = new Map<number, number[]>();
        for (let i = 0; i < structures.length; i++) {
          const root = find(i);
          const arr = clusters.get(root) ?? [];
          arr.push(i);
          clusters.set(root, arr);
        }

        const ranked = [...clusters.values()]
          .filter(members => members.length >= 2)
          .map(members => {
            const wasteBytes =
              members.reduce((s, i) => s + structures[i].wasteSlots, 0) *
              slotBytes;
            const shared = new Set<number>(structures[members[0]].keySet);
            for (const i of members.slice(1)) {
              for (const k of [...shared]) {
                if (!structures[i].keySet.has(k)) shared.delete(k);
              }
            }
            return {members, wasteBytes, shared};
          })
          .filter(c => c.wasteBytes >= min_cluster_waste)
          .sort((a, b) => b.wasteBytes - a.wasteBytes);

        const lines: string[] = [
          '## Shared integer id spaces',
          '',
          `Compared ${formatNumber(structures.length)} sparse integer-keyed structure(s) (the ${formatNumber(picked.length)} with the most unused capacity, of ${formatNumber(candidates.length)} sparse in total).`,
          '',
        ];

        if (ranked.length === 0) {
          lines.push(
            `No two structures share at least ${Math.round(min_similarity * 100)}% of their keys. Each sparse store here has its own key space, so there is no single re-keying that would fix several at once — treat the \`memlab_sparse_elements\` rows as independent.`,
          );
          return toolResult(lines.join('\n'));
        }

        for (const cluster of ranked.slice(0, limit)) {
          const allMembers = cluster.members
            .map(i => structures[i])
            .sort((a, b) => b.wasteSlots - a.wasteSlots);
          // A cluster can legitimately have hundreds of members (one cache per
          // model). Showing them all buries the point, which is the COMBINED
          // number and the distinct owners.
          const members = allMembers.slice(0, 12);
          lines.push(
            `### ${formatNumber(allMembers.length)} structures sharing one id space — **${formatBytes(cluster.wasteBytes)}** unused between them`,
            '',
            `Distinct owners: ${[...new Set(allMembers.map(m => m.label))]
              .slice(0, 8)
              .map(l => `\`${l}\``)
              .join(
                ', ',
              )}${new Set(allMembers.map(m => m.label)).size > 8 ? ', …' : ''}`,
            '',
            markdownTable(
              ['Structure', 'Sparse keys', 'Used / cap', 'Unused', 'Node'],
              members.map(m => [
                m.label,
                formatNumber(m.keys.length),
                `${formatNumber(m.used)} / ${formatNumber(m.capacity)}`,
                formatBytes(m.wasteSlots * slotBytes),
                `@${m.nodeId}`,
              ]),
              new Set([1, 2, 3]),
            ),
            allMembers.length > members.length
              ? `_${formatNumber(allMembers.length - members.length)} further member(s) in this cluster not shown._`
              : '',
            '',
          );
          if (cluster.shared.size > 0) {
            const sample = [...cluster.shared]
              .sort((a, b) => a - b)
              .slice(0, 12);
            lines.push(
              `Keys written by EVERY member: ${sample.map(k => `\`${k}\``).join(', ')}${cluster.shared.size > sample.length ? `, +${formatNumber(cluster.shared.size - sample.length)} more` : ''}. ` +
                'Indices agreeing across unrelated structures is what an id allocator handed out as an array subscript looks like.',
              '',
            );
          }
          lines.push(
            `**Fix once, pay off ${formatNumber(allMembers.length)} times:** assign these ids densely at first use (or key the structures by a \`Map\` instead of an array subscript). Sizing any one of them alone recovers only its own share.`,
            '',
          );
        }
        if (ranked.length > limit) {
          lines.push(
            `_${formatNumber(ranked.length - limit)} further cluster(s) not shown; raise \`limit\`._`,
            '',
          );
        }

        lines.push(
          `_Compared on SPARSE keys only — indices at or below a structure's own key count are dropped, because a densely packed array has keys 0..N-1 by construction and would otherwise match everything. Up to ${formatNumber(MAX_KEYS_PER_STRUCTURE)} keys per structure, sampled evenly across the range, so a high score is strong evidence and a low one on very large key sets is not proof they differ._`,
        );

        if (!suggestionsSuppressed('memlab_id_space_audit')) {
          lines.push(
            '',
            '**Suggested next steps**',
            `- \`memlab_sparse_elements\` — the per-structure view these clusters are built from.`,
            `- \`memlab_retainer_trace\` on a member node id — confirm the owner label before writing the fix.`,
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
