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
import {
  errorResult,
  formatBytes,
  formatNumber,
  isNodeWorthInspecting,
  markdownTable,
  toolResult,
  truncateNodeName,
} from '../utils.js';
import {normalizeClassName} from './sequence-analysis.js';

/**
 * A population selector: which nodes the comparison is about.
 *
 * `detached` is the motivating case — see the tool description — but the same
 * question ("is this the SAME set, or a set of the same size?") applies to any
 * population a hunt is tracking.
 */
export type Population =
  | {kind: 'detached'}
  | {kind: 'class'; name: string}
  | {kind: 'shape'; props: string[]};

export function parsePopulation(spec: string): Population {
  const trimmed = spec.trim();
  if (trimmed === 'detached') return {kind: 'detached'};
  if (trimmed.startsWith('class:')) {
    const name = trimmed.slice('class:'.length).trim();
    if (name.length === 0) {
      throw new Error('Empty class name in population "class:".');
    }
    return {kind: 'class', name};
  }
  if (trimmed.startsWith('shape:')) {
    const props = trimmed
      .slice('shape:'.length)
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, ''))
      .filter(s => s.length > 0);
    if (props.length === 0) {
      throw new Error('Empty property list in population "shape:".');
    }
    return {kind: 'shape', props};
  }
  throw new Error(
    `Unrecognized population "${spec}". Use "detached", "class:<ClassName>", or "shape:prop1,prop2".`,
  );
}

function isDetached(node: IHeapNode): boolean {
  if (node.id <= 3) return false;
  return node.is_detached || node.name.startsWith('Detached ');
}

/**
 * Membership test for a population selector. Shared with
 * `memlab_dominator_attribution` so the two tools cannot drift on what, for
 * example, "detached" means — a difference there would make their numbers
 * silently incomparable.
 */
export function makeMembershipTest(
  pop: Population,
): (node: IHeapNode) => boolean {
  switch (pop.kind) {
    case 'detached':
      return isDetached;
    case 'class': {
      const want = pop.name;
      return (node: IHeapNode) => node.id > 3 && node.name === want;
    }
    case 'shape': {
      const want = pop.props;
      return (node: IHeapNode) => {
        if (node.id <= 3 || node.type !== 'object') return false;
        let hits = 0;
        const seen = new Set<string>();
        for (const edge of node.references) {
          if (edge.type !== 'property') continue;
          const name = String(edge.name_or_index);
          if (!want.includes(name) || seen.has(name)) continue;
          seen.add(name);
          if (++hits === want.length) return true;
        }
        return false;
      };
    }
  }
}

/**
 * Composition key for one member. This is the axis the two ends are compared
 * ALONG: two populations of equal size are only the same population if every
 * bucket also matches.
 */
type GroupBy = 'class' | 'owner' | 'type' | 'shape';

// Bound on the upward dominator walk when grouping by owner, mirroring
// `boundedDominatorRetainedSize`. A truncated walk yields '(no owner found)'
// rather than a wrong owner.
const MAX_OWNER_HOPS = 500;

function domTagKey(name: string): string {
  const detached = name.startsWith('Detached ') ? 'Detached ' : '';
  const bare = detached ? name.slice(9) : name;
  const tag = bare.match(/^<(\w+)/)?.[1];
  return tag ? `${detached}<${tag}>` : normalizeClassName(name);
}

function ownerKey(node: IHeapNode): string {
  let cur: IHeapNode | null = node.dominatorNode ?? null;
  let hops = 0;
  while (cur && hops++ < MAX_OWNER_HOPS) {
    if (cur.id === node.id) break;
    if (
      cur.name !== '(GC roots)' &&
      cur.id > 3 &&
      isNodeWorthInspecting(cur) &&
      !isDetached(cur)
    ) {
      // Deliberately NOT keyed by node id: ids are per-capture, so an id key
      // would make every bucket "added" in the target and "removed" in the
      // baseline. The owner's CLASS is what is comparable across snapshots.
      return normalizeClassName(
        truncateNodeName(cur.name, cur.type, cur.self_size, 60),
      );
    }
    const next: IHeapNode | null = cur.dominatorNode ?? null;
    if (!next || next.id === cur.id) break;
    cur = next;
  }
  return '(no owner — dominated by the GC root)';
}

function shapeKey(node: IHeapNode): string {
  const props: string[] = [];
  for (const edge of node.references) {
    if (edge.type !== 'property') continue;
    const name = String(edge.name_or_index);
    if (name === '__proto__') continue;
    props.push(name);
  }
  if (props.length === 0) return '(no properties)';
  props.sort();
  const joined = props.join(',');
  return joined.length > 80 ? joined.slice(0, 77) + '…' : joined;
}

function makeKeyFn(
  groupBy: GroupBy,
  pop: Population,
): (node: IHeapNode) => string {
  switch (groupBy) {
    case 'owner':
      return ownerKey;
    case 'type':
      return (node: IHeapNode) => node.type;
    case 'shape':
      return shapeKey;
    case 'class':
      return pop.kind === 'detached'
        ? (node: IHeapNode) => domTagKey(node.name)
        : (node: IHeapNode) => normalizeClassName(node.name);
  }
}

interface Bucket {
  count: number;
  selfSize: number;
}

interface Census {
  buckets: Map<string, Bucket>;
  total: number;
  totalSelf: number;
}

function census(
  snapshot: IHeapSnapshot,
  isMember: (node: IHeapNode) => boolean,
  keyOf: (node: IHeapNode) => string,
): Census {
  const buckets = new Map<string, Bucket>();
  let total = 0;
  let totalSelf = 0;
  snapshot.nodes.forEach(node => {
    if (!isMember(node)) return;
    total++;
    totalSelf += node.self_size;
    const key = keyOf(node);
    const b = buckets.get(key);
    if (b) {
      b.count++;
      b.selfSize += node.self_size;
    } else {
      buckets.set(key, {count: 1, selfSize: node.self_size});
    }
  });
  return {buckets, total, totalSelf};
}

/**
 * The verdict this tool exists to produce. Equal totals have three distinct
 * causes and they call for opposite conclusions, so the headline states which
 * one holds rather than leaving the reader to infer it from the table.
 */
export function summarizeComposition(
  a: Census,
  b: Census,
): {headline: string; added: number; removed: number} {
  let added = 0;
  let removed = 0;
  for (const key of new Set([...a.buckets.keys(), ...b.buckets.keys()])) {
    const d =
      (b.buckets.get(key)?.count ?? 0) - (a.buckets.get(key)?.count ?? 0);
    if (d > 0) added += d;
    else removed += -d;
  }
  const netTotal = b.total - a.total;
  if (added === 0 && removed === 0) {
    return {
      headline: `✅ **Identical composition** — every one of the ${formatNumber(a.buckets.size)} bucket(s) has the same count at both ends. The population did not just stay the same SIZE, it stayed the same population.`,
      added,
      removed,
    };
  }
  if (netTotal === 0) {
    return {
      headline: `⚠ **Equal totals, DIFFERENT composition** — ${formatNumber(added)} member(s) appeared and ${formatNumber(removed)} disappeared, and they cancel out. Do NOT read the equal total as "nothing changed": the round stranded and freed in equal measure, which is exactly what a leak paired with an eviction looks like.`,
      added,
      removed,
    };
  }
  return {
    headline: `Population ${netTotal > 0 ? 'grew' : 'shrank'} by **${formatNumber(Math.abs(netTotal))}** (${formatNumber(a.total)} → ${formatNumber(b.total)}); ${formatNumber(added)} appeared, ${formatNumber(removed)} disappeared.`,
    added,
    removed,
  };
}

export function registerPopulationDiff(server: McpServer): void {
  server.tool(
    'memlab_population_diff',
    'Compare the COMPOSITION of a population between two loaded snapshots, not just its size. Equal totals are not identity: a round that strands N objects and frees N others reports the same count at both ends, and reading that as "nothing leaked" is a wrong verdict a count comparison cannot catch. This breaks the population into buckets (class, dominator-owner class, node type, or object shape), reports both ends per bucket, and states which of the three cases holds — identical composition / equal totals but different composition / net growth. ' +
      'Populations: "detached" (all detached DOM), "class:<ClassName>", or "shape:prop1,prop2" (objects carrying all of those properties). ' +
      'Buckets are keyed by CLASS, never by node id — ids are per-capture, so an id-keyed comparison reports every member as both added and removed. Both snapshots must be resident: load them with keep_previous:true.',
    {
      baseline_handle: z
        .string()
        .describe(
          'Handle of the earlier snapshot (memlab_snapshots lists them).',
        ),
      target_handle: z
        .string()
        .optional()
        .describe(
          'Handle of the later snapshot. Defaults to the current snapshot.',
        ),
      population: z
        .string()
        .describe(
          'Which nodes to compare: "detached", "class:<ClassName>", or "shape:prop1,prop2".',
        ),
      group_by: z
        .enum(['class', 'owner', 'type', 'shape'])
        .optional()
        .describe(
          'Composition axis. "class" = the member\'s own class (for detached DOM, its element tag); "owner" = the class of its nearest accountable dominator (needs a full, non-light load); "type" = heap node type; "shape" = its sorted property-name set. Defaults to "owner" for a class: population (the members already share a class, so their own name carries no information) and "class" otherwise.',
        ),
      limit: z
        .number()
        .optional()
        .default(25)
        .describe('Maximum buckets to show in the table (default 25).'),
      min_delta: z
        .number()
        .optional()
        .default(0)
        .describe(
          'Hide buckets whose count moved by less than this (default 0: show everything, since an unchanged bucket is itself evidence).',
        ),
    },
    async ({
      baseline_handle,
      target_handle,
      population,
      group_by,
      limit,
      min_delta,
    }) => {
      try {
        const pop = parsePopulation(population);
        const targetHandle = target_handle ?? getCurrentHandle();
        if (targetHandle == null) {
          return errorResult('No current snapshot; pass target_handle.');
        }
        if (targetHandle === baseline_handle) {
          return errorResult(
            'baseline_handle and target_handle are the same snapshot.',
          );
        }
        const baseline = getSnapshotByHandle(baseline_handle);
        const target = getSnapshotByHandle(targetHandle);
        if (baseline == null || target == null) {
          const available = listSnapshots()
            .map(m => m.handle)
            .join(', ');
          return errorResult(
            `Both snapshots must be resident. Missing: ${baseline == null ? baseline_handle : targetHandle}. Resident: ${available || '(none)'}. Load with memlab_load_snapshot({file_path, keep_previous: true}).`,
          );
        }

        const groupBy: GroupBy =
          group_by ?? (pop.kind === 'class' ? 'owner' : 'class');
        if (groupBy === 'owner') {
          for (const h of [baseline_handle, targetHandle]) {
            if (getMetadataByHandle(h)?.light) {
              return errorResult(
                `Snapshot "${h}" was loaded in LIGHT mode and has no dominator tree, which group_by:"owner" requires. Reload it without light, or group by "class" / "type" / "shape".`,
              );
            }
          }
        }

        const isMember = makeMembershipTest(pop);
        const keyOf = makeKeyFn(groupBy, pop);
        const a = census(baseline, isMember, keyOf);
        const b = census(target, isMember, keyOf);

        if (a.total === 0 && b.total === 0) {
          return toolResult(
            `No nodes match population \`${population}\` in either snapshot — nothing to compare. Check the class name with \`memlab_class_histogram\`, or the property names with \`memlab_shape_histogram\`.`,
          );
        }

        const {headline, added, removed} = summarizeComposition(a, b);

        const keys = new Set([...a.buckets.keys(), ...b.buckets.keys()]);
        const rows: {
          key: string;
          before: number;
          after: number;
          delta: number;
          bytesDelta: number;
        }[] = [];
        for (const key of keys) {
          const before = a.buckets.get(key);
          const after = b.buckets.get(key);
          const delta = (after?.count ?? 0) - (before?.count ?? 0);
          if (Math.abs(delta) < min_delta) continue;
          rows.push({
            key,
            before: before?.count ?? 0,
            after: after?.count ?? 0,
            delta,
            bytesDelta: (after?.selfSize ?? 0) - (before?.selfSize ?? 0),
          });
        }
        // Movers first (largest |Δ|), then the stable buckets by size — the
        // stable ones are the evidence behind an "identical composition"
        // verdict, so they are shown, just not ahead of the changes.
        rows.sort(
          (x, y) => Math.abs(y.delta) - Math.abs(x.delta) || y.after - x.after,
        );
        const shown = rows.slice(0, limit);

        const addedKeys = [...keys].filter(
          k => !a.buckets.has(k) && b.buckets.has(k),
        );
        const removedKeys = [...keys].filter(
          k => a.buckets.has(k) && !b.buckets.has(k),
        );

        const axisLabel =
          groupBy === 'owner'
            ? 'Owner (dominator class)'
            : groupBy === 'shape'
              ? 'Shape (property names)'
              : groupBy === 'type'
                ? 'Node type'
                : 'Class';

        const lines: string[] = [
          `## Population diff \`${population}\` by ${groupBy}: "${baseline_handle}" → "${targetHandle}"`,
          '',
          `Members: ${formatNumber(a.total)} (${formatBytes(a.totalSelf)} self) → ${formatNumber(b.total)} (${formatBytes(b.totalSelf)} self), across ${formatNumber(a.buckets.size)} → ${formatNumber(b.buckets.size)} bucket(s).`,
          '',
          headline,
          '',
          markdownTable(
            [axisLabel, 'Before', 'After', 'Δ count', 'Δ self'],
            shown.map(r => [
              r.key.length > 52 ? r.key.slice(0, 49) + '…' : r.key,
              formatNumber(r.before),
              formatNumber(r.after),
              r.delta === 0
                ? '—'
                : `${r.delta > 0 ? '+' : '−'}${formatNumber(Math.abs(r.delta))}`,
              r.bytesDelta === 0
                ? '—'
                : `${r.bytesDelta > 0 ? '+' : '−'}${formatBytes(Math.abs(r.bytesDelta))}`,
            ]),
            new Set([1, 2, 3, 4]),
          ),
        ];
        if (rows.length > shown.length) {
          lines.push(
            '',
            `_${formatNumber(rows.length - shown.length)} further bucket(s) not shown (raise \`limit\`)._`,
          );
        }
        if (addedKeys.length > 0) {
          lines.push(
            '',
            `**Buckets present only in the target (${formatNumber(addedKeys.length)}):** ${addedKeys
              .slice(0, 15)
              .map(k => `\`${k}\``)
              .join(', ')}${addedKeys.length > 15 ? ', …' : ''}`,
          );
        }
        if (removedKeys.length > 0) {
          lines.push(
            '',
            `**Buckets present only in the baseline (${formatNumber(removedKeys.length)}):** ${removedKeys
              .slice(0, 15)
              .map(k => `\`${k}\``)
              .join(', ')}${removedKeys.length > 15 ? ', …' : ''}`,
          );
        }
        if (added > 0 || removed > 0) {
          lines.push(
            '',
            `_Churn is measured per bucket, so it is a LOWER bound on how many individual objects were replaced: two members swapping within one bucket are invisible here. Node identity cannot be tracked across captures — ids are per-capture — so this is the strongest available statement._`,
          );
        }
        lines.push(
          '',
          `**Next:** ${
            groupBy === 'owner'
              ? 'Use `memlab_dominator_attribution` on the owners that moved to measure how much each actually pins.'
              : 'Re-run with `group_by: "owner"` to see WHICH object holds the buckets that moved, then `memlab_dominator_attribution` to size each owner.'
          }`,
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
