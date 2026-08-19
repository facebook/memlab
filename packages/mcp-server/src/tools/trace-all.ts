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
import {getSnapshot, getSnapshotMetadata} from '../heap-state.js';
import {
  formatTraceChain,
  getRetainerTrace,
  traceToKey,
  type TraceStep,
} from './retainer-summary.js';
import {
  boundedDominatorRetainedSize,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

const {NumericSet} = memlabCore;

// Tracing is a pointer walk per node, so the whole population is affordable at
// heap scale — but not without a bound, because a pathological graph turns it
// into the load-time dominator pass all over again.
const DEFAULT_MAX_TRACE = 200000;

export interface TraceCluster {
  key: string;
  steps: TraceStep[];
  count: number;
  selfSize: number;
  exampleIds: number[];
  // Member ids, capped: retained-size accounting needs the set, but holding
  // every id of a million-member cluster costs more than the answer is worth.
  ids: number[];
  idsTruncated: boolean;
}

const MAX_IDS_PER_CLUSTER = 50000;

/**
 * Render a cluster's chain. When a path was truncated for grouping, its last
 * step still carries the edge leading to the next hop, and that edge IS part
 * of the grouping key — so suppressing it (which is correct for a complete
 * path, whose last node is the target) renders two distinct clusters
 * byte-identically. Show it, with a marker for the hops beyond.
 */
export function renderClusterChain(steps: TraceStep[]): string {
  const base = formatTraceChain(steps);
  const last = steps[steps.length - 1];
  return last?.edgeName != null ? `${base} --${last.edgeName}--> ⋯` : base;
}

export function selectPopulation(
  snapshot: IHeapSnapshot,
  sel: {nodeIds?: number[]; className?: string; shape?: string[]},
): IHeapNode[] {
  const out: IHeapNode[] = [];
  if (sel.nodeIds != null && sel.nodeIds.length > 0) {
    for (const id of sel.nodeIds) {
      const n = snapshot.getNodeById(id);
      if (n != null) out.push(n);
    }
    return out;
  }
  const want = sel.shape != null ? new Set(sel.shape) : null;
  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;
    if (sel.className != null) {
      if (node.name !== sel.className) return;
    } else if (want != null) {
      const remaining = new Set(want);
      for (const e of node.references) {
        if (e.type !== 'property') continue;
        remaining.delete(String(e.name_or_index));
        if (remaining.size === 0) break;
      }
      if (remaining.size > 0) return;
    }
    out.push(node);
  });
  return out;
}

export function clusterByRetainerPath(
  nodes: IHeapNode[],
  frameworkFilter: boolean,
  maxTrace: number,
  // Hops from the GC root to key on. Paths are root-first, so truncating keeps
  // the owner side and collapses per-instance leaves — the difference between
  // "one owner, 40,000 objects" and 26,000 one-object paths that differ only
  // in which array index they sit at.
  maxDepth?: number,
): {
  clusters: TraceCluster[];
  traced: number;
  noPath: number;
  truncated: boolean;
} {
  const byKey = new Map<string, TraceCluster>();
  let traced = 0;
  let noPath = 0;
  let truncated = false;
  for (const node of nodes) {
    if (traced + noPath >= maxTrace) {
      truncated = true;
      break;
    }
    const steps = getRetainerTrace(node);
    if (steps == null) {
      noPath++;
      continue;
    }
    traced++;
    const keySteps =
      maxDepth != null && maxDepth > 0 && maxDepth < steps.length
        ? steps.slice(0, maxDepth)
        : steps;
    const key = traceToKey(keySteps, frameworkFilter);
    const existing = byKey.get(key);
    if (existing != null) {
      existing.count++;
      existing.selfSize += node.self_size;
      if (existing.exampleIds.length < 3) existing.exampleIds.push(node.id);
      if (existing.ids.length < MAX_IDS_PER_CLUSTER) existing.ids.push(node.id);
      else existing.idsTruncated = true;
    } else {
      byKey.set(key, {
        key,
        steps: keySteps,
        count: 1,
        selfSize: node.self_size,
        exampleIds: [node.id],
        ids: [node.id],
        idsTruncated: false,
      });
    }
  }
  const clusters = [...byKey.values()].sort((a, b) => b.count - a.count);
  return {clusters, traced, noPath, truncated};
}

export function registerTraceAll(server: McpServer): void {
  server.tool(
    'memlab_trace_all',
    'Retainer-trace an ENTIRE population and cluster the paths server-side, instead of sampling a handful and hoping they are representative.\n\n' +
      '`memlab_retainer_summary` samples ~10 instances and stops early once they agree, which is the right default for a quick read but is structurally unable to find a minority path: a cluster holding 3% of the objects and 60% of the bytes is invisible to it, and that cluster is very often the leak. This traces every member (bounded, and it says so when the bound is hit), groups by structural path signature, and reports each cluster with its share of the population — so the output cost is the number of DISTINCT paths, not the size of the population.\n\n' +
      'Select by class, shape or explicit ids. Use it when a population is large enough that "are they all retained the same way?" is the question, and when a sampled answer has already been used to justify a conclusion.',
    {
      class_name: z
        .string()
        .optional()
        .describe('Trace every instance of this class (exact name match).'),
      shape: z
        .array(z.string())
        .optional()
        .describe(
          'Trace every object carrying ALL of these properties — the usable selector on a minified heap.',
        ),
      node_ids: z
        .array(z.number())
        .optional()
        .describe('Trace exactly these node ids.'),
      framework_filter: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Collapse V8/framework internals (system / Context, PromiseReaction, …) out of the grouping key so structurally identical application paths cluster together (default true).',
        ),
      limit: z
        .number()
        .optional()
        .default(8)
        .describe('Clusters to render in full (default 8).'),
      exact_bytes: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Compute dominator-deduped retained bytes for each rendered cluster (default true). Turn off on very large populations if the walk is slow; self size is always reported.',
        ),
      max_depth: z
        .number()
        .optional()
        .describe(
          'Group on the first N hops from the GC ROOT instead of the whole path. Defaults to the whole path, which is exact but fragments when the leaf hop is per-instance — a per-chat property edge or a per-event listener array gives nearly one path per object. Try 5-7 to see owners rather than instances.',
        ),
      max_trace: z
        .number()
        .optional()
        .default(DEFAULT_MAX_TRACE)
        .describe(
          `Safety bound on how many nodes to trace (default ${formatNumber(DEFAULT_MAX_TRACE)}). Truncation is always reported — a partial sweep is never presented as a complete one.`,
        ),
    },
    async ({
      class_name,
      shape,
      node_ids,
      framework_filter,
      limit,
      exact_bytes,
      max_depth,
      max_trace,
    }) => {
      try {
        const snapshot = getSnapshot();
        const selectors = [
          class_name != null,
          shape != null && shape.length > 0,
          node_ids != null && node_ids.length > 0,
        ].filter(Boolean).length;
        if (selectors !== 1) {
          return errorResult(
            new Error(
              'Pass exactly one of class_name / shape / node_ids — combining them would make the reported population ambiguous.',
            ),
          );
        }

        const nodes = selectPopulation(snapshot, {
          nodeIds: node_ids,
          className: class_name,
          shape,
        });
        if (nodes.length === 0) {
          return toolResult(
            'Nothing matched. Check the class name with `memlab_class_histogram` or the shape with `memlab_shape_histogram`.',
          );
        }

        const {clusters, traced, noPath, truncated} = clusterByRetainerPath(
          nodes,
          framework_filter,
          max_trace,
          max_depth,
        );
        if (clusters.length === 0) {
          return toolResult(
            `All ${formatNumber(nodes.length)} matched objects have no retainer path — they are unreachable and awaiting collection, not retained. Nothing to trace.`,
          );
        }

        const label =
          class_name != null
            ? `class \`${class_name}\``
            : shape != null
              ? `shape \`{${shape.join(', ')}}\``
              : `${formatNumber(nodes.length)} explicit id(s)`;

        const meta = getSnapshotMetadata();
        const rendered = clusters.slice(0, limit);
        const bytesByKey = new Map<
          string,
          {retained: number; exact: boolean}
        >();
        if (exact_bytes) {
          for (const c of rendered) {
            // Only the rendered clusters get the dominator walk: it is the
            // expensive part, and a cluster nobody sees does not need a number
            // attached to it. Member ids were collected during the single
            // clustering pass, so this does not re-walk the population.
            const bytes = boundedDominatorRetainedSize(
              new NumericSet(c.ids),
              snapshot,
            );
            bytesByKey.set(c.key, {
              retained: bytes.retained,
              exact: bytes.exact && !c.idsTruncated,
            });
          }
        }

        const totalTraced = traced;
        const rows = rendered.map((c, i) => {
          const bytes = bytesByKey.get(c.key);
          return [
            String(i + 1),
            formatNumber(c.count),
            `${((c.count / totalTraced) * 100).toFixed(1)}%`,
            formatBytes(c.selfSize),
            bytes != null
              ? `${formatBytes(bytes.retained)}${bytes.exact ? '' : ' (ub)'}`
              : '—',
            `@${c.exampleIds[0]}`,
          ];
        });

        const lines: string[] = [
          `## Retainer paths for ${label}`,
          '',
          `**${formatNumber(traced)} of ${formatNumber(nodes.length)} traced** into **${formatNumber(clusters.length)} distinct path${clusters.length === 1 ? '' : 's'}**` +
            `${noPath > 0 ? `; ${formatNumber(noPath)} had no retainer path (unreachable, awaiting collection)` : ''}` +
            `${truncated ? `. ⚠ Stopped at the ${formatNumber(max_trace)}-node bound, so this is a partial sweep — raise max_trace for the full population` : ''}.`,
          '',
          markdownTable(
            ['#', 'Objects', 'Share', 'Self size', 'Retained', 'Example'],
            rows,
            new Set([1, 2, 3, 4]),
          ),
        ];

        // A path count close to the population count means the signature is
        // keying on something per-instance, and every cluster is a single
        // object wearing a path. That reads as "no dominant owner" when the
        // truth may be one owner and a per-instance leaf hop.
        if (max_depth == null && clusters.length > totalTraced * 0.5) {
          lines.push(
            '',
            `⚠ ${formatNumber(clusters.length)} paths for ${formatNumber(totalTraced)} objects — the full-depth signature is keying on a per-instance hop (a per-chat property edge, a per-event listener array), so almost every object is its own "path". Re-run with \`max_depth: 5\` (or 6-7) to group on the owner side of the chain instead. Shares below are computed over this fragmented grouping and should not be read as "no dominant owner".`,
          );
        }

        if (clusters.length > rendered.length) {
          const rest = clusters.slice(rendered.length);
          const restCount = rest.reduce((a, c) => a + c.count, 0);
          lines.push(
            '',
            `_${formatNumber(clusters.length - rendered.length)} further path(s) hold ${formatNumber(restCount)} object(s) (${((restCount / totalTraced) * 100).toFixed(1)}%); raise \`limit\` to render them._`,
          );
        }

        // The whole point of a full sweep is that it can see what sampling
        // cannot, so say when it did.
        const minority = clusters.filter(
          c => c.count / totalTraced < 0.1 && c.count > 0,
        );
        if (clusters.length > 1) {
          const dominant = clusters[0];
          const dominantShare = (dominant.count / totalTraced) * 100;
          lines.push(
            '',
            dominantShare >= 95
              ? `**One path dominates** (${dominantShare.toFixed(1)}%): a single retention mechanism, and a fix at that owner addresses effectively the whole population.`
              : `**Retention is split across ${formatNumber(clusters.length)} paths**, the largest holding ${dominantShare.toFixed(1)}%. A fix aimed at one owner leaves the rest — size it against the cluster, not the class total.`,
          );
          if (minority.length > 0) {
            const minCount = minority.reduce((a, c) => a + c.count, 0);
            lines.push(
              '',
              `⚠ ${formatNumber(minority.length)} path(s) below 10% share, holding ${formatNumber(minCount)} object(s) in total. A 10-instance sample would very likely have missed every one of them; check whether any is the interesting one before concluding the population is homogeneous.`,
            );
          }
        }

        rendered.forEach((c, i) => {
          const bytes = bytesByKey.get(c.key);
          lines.push(
            '',
            `### Path ${i + 1} — ${formatNumber(c.count)} object(s), ${((c.count / totalTraced) * 100).toFixed(1)}%${bytes != null ? `, ${formatBytes(bytes.retained)} retained` : ''}`,
            '',
            renderClusterChain(c.steps),
            '',
            `Examples: ${c.exampleIds.map(id => `@${id}`).join(', ')}`,
          );
        });

        lines.push(
          '',
          `_Paths are grouped by structural signature${framework_filter ? ' with framework internals collapsed' : ''}; per-instance node ids in V8 internal names are normalized out, so two rows are never byte-identical. Retained bytes are dominator-deduped within a cluster and do not add up across clusters when one cluster dominates another._`,
          '',
          `Next: \`memlab_what_if\` to size a fix at one owner, \`memlab_identify\` to name the population, \`memlab_retainer_diff\` to see whether these paths are the ones that grew.${meta != null ? '' : ''}`,
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
