/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapSnapshot} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {
  getSnapshotByHandle,
  getMetadataByHandle,
  getCurrentHandle,
  listSnapshots,
} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';
import {classifyArtifact} from '../artifact-classes.js';
import {normalizeClassName} from './sequence-analysis.js';

interface OwnerStats {
  selfBytes: number;
  nodes: number;
}

/**
 * Attribute every node's SELF size to its immediate dominator's class.
 *
 * Self size, not retained: retained sizes overlap wherever objects nest, so
 * summing them per owner reports more memory than exists (a sum over one class
 * in a 200 MB heap has been measured at 5.9 GB). Self sizes partition the heap
 * exactly, which is what makes two snapshots comparable.
 *
 * Immediate dominator, not nearest app-owned ancestor: resolving an owner chain
 * per node needs a memo table the size of the heap, and on a multi-million-node
 * snapshot that is a large allocation to make while answering a question about
 * memory. The immediate dominator is already the accountable parent for the
 * bytes hanging off it, and it is one field read per node.
 */
function attributeByOwner(snapshot: IHeapSnapshot): {
  byOwner: Map<string, OwnerStats>;
  totalSelf: number;
} {
  const byOwner = new Map<string, OwnerStats>();
  let totalSelf = 0;
  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;
    totalSelf += node.self_size;
    const dom = node.dominatorNode;
    // Normalize the per-instance node id V8 appends to Context/scope names
    // ("system / Context / scope @706909"). Those ids differ per capture, so
    // without this every scope looks like an owner that appeared from nothing
    // in the target and vanished from the baseline — pure phantom delta.
    const key =
      dom == null || dom.id === node.id
        ? '(GC roots)'
        : dom.name.length > 0
          ? normalizeClassName(dom.name)
          : `(unnamed ${dom.type})`;
    const e = byOwner.get(key);
    if (e) {
      e.selfBytes += node.self_size;
      e.nodes++;
    } else {
      byOwner.set(key, {selfBytes: node.self_size, nodes: 1});
    }
  });
  return {byOwner, totalSelf};
}

export function registerExplainDelta(server: McpServer): void {
  server.tool(
    'memlab_explain_delta',
    'Explain WHERE a heap grew between two loaded snapshots, attributed by dominator (who owns the new bytes) rather than by class (what the new bytes are). ' +
      '"Object grew by 99,418 instances" does not tell you what to fix; "the bytes hanging off CometStyleXSheet grew by 12 MB" does. Every node\'s SELF size is attributed to its immediate dominator\'s class and the two attributions are differenced, so the numbers partition the heap and add up — unlike a per-class sum of retained sizes, which double-counts nested objects and can exceed the heap. ' +
      'Known measurement-artifact owners (JIT warmup, CDP inspector, a11y caches, captured Error stacks) are flagged so an inspector-driven delta is not read as an application regression. Both snapshots must be resident: load them with keep_previous:true.',
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
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum owners to report per direction (default 20).'),
      min_delta_bytes: z
        .number()
        .optional()
        .default(65536)
        .describe(
          'Ignore owners whose attributed size moved by less than this (default 64 KB).',
        ),
      include_artifacts: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Include owners that are known measurement artifacts (default false: counted in a one-line summary instead).',
        ),
    },
    async ({
      baseline_handle,
      target_handle,
      limit,
      min_delta_bytes,
      include_artifacts,
    }) => {
      try {
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
        for (const h of [baseline_handle, targetHandle]) {
          if (getMetadataByHandle(h)?.light) {
            return errorResult(
              `Snapshot "${h}" was loaded in LIGHT mode and has no dominator tree, which this attribution requires. Reload it without light.`,
            );
          }
        }

        const a = attributeByOwner(baseline);
        const b = attributeByOwner(target);

        interface Row {
          owner: string;
          delta: number;
          before: number;
          after: number;
          nodesDelta: number;
          artifact: boolean;
        }
        const rows: Row[] = [];
        const owners = new Set([...a.byOwner.keys(), ...b.byOwner.keys()]);
        for (const owner of owners) {
          const before = a.byOwner.get(owner);
          const after = b.byOwner.get(owner);
          const delta = (after?.selfBytes ?? 0) - (before?.selfBytes ?? 0);
          if (Math.abs(delta) < min_delta_bytes) continue;
          rows.push({
            owner,
            delta,
            before: before?.selfBytes ?? 0,
            after: after?.selfBytes ?? 0,
            nodesDelta: (after?.nodes ?? 0) - (before?.nodes ?? 0),
            artifact: classifyArtifact(owner) != null,
          });
        }

        const totalDelta = b.totalSelf - a.totalSelf;
        const lines: string[] = [
          `## Heap delta by owner: "${baseline_handle}" → "${targetHandle}"`,
          '',
          `Total self size ${totalDelta >= 0 ? 'grew' : 'shrank'} by **${formatBytes(Math.abs(totalDelta))}** (${formatBytes(a.totalSelf)} → ${formatBytes(b.totalSelf)}).`,
          '',
        ];

        const artifactRows = rows.filter(r => r.artifact);
        const usable = include_artifacts ? rows : rows.filter(r => !r.artifact);
        const grew = usable
          .filter(r => r.delta > 0)
          .sort((x, y) => y.delta - x.delta)
          .slice(0, limit);
        const shrank = usable
          .filter(r => r.delta < 0)
          .sort((x, y) => x.delta - y.delta)
          .slice(0, limit);

        if (grew.length === 0 && shrank.length === 0) {
          lines.push(
            `No owner moved by at least ${formatBytes(min_delta_bytes)}. The change is spread thinly rather than concentrated under one owner — lower \`min_delta_bytes\`, or compare class counts with \`memlab_diff_snapshots\`.`,
          );
          return toolResult(lines.join('\n'));
        }

        const render = (rs: Row[]): string =>
          markdownTable(
            ['Owner (dominator class)', 'Δ self', 'Before', 'After', 'Δ nodes'],
            rs.map(r => [
              r.owner.length > 44 ? r.owner.slice(0, 41) + '…' : r.owner,
              `${r.delta >= 0 ? '+' : '−'}${formatBytes(Math.abs(r.delta))}`,
              formatBytes(r.before),
              formatBytes(r.after),
              `${r.nodesDelta >= 0 ? '+' : '−'}${formatNumber(Math.abs(r.nodesDelta))}`,
            ]),
            new Set([1, 2, 3, 4]),
          );

        if (grew.length > 0) {
          lines.push('### Owners that grew', '', render(grew), '');
        }
        if (shrank.length > 0) {
          lines.push('### Owners that shrank', '', render(shrank), '');
        }
        if (!include_artifacts && artifactRows.length > 0) {
          const bytes = artifactRows.reduce((s, r) => s + r.delta, 0);
          lines.push(
            `> 🧹 **${formatNumber(artifactRows.length)} owner(s) suppressed as known measurement artifacts** (net ${bytes >= 0 ? '+' : '−'}${formatBytes(Math.abs(bytes))}) — JIT warmup, CDP inspector retention, a11y caches, captured Error stacks. Pass \`include_artifacts: true\` to see them.`,
            '> Note the split of responsibilities: the JIT-warmup families counted here (`system/Code`, `InstructionStream`, `BytecodeArray`, `ProtectedFixedArray`) are NOT counted by `memlab_dev_artifacts`, which measures retention by a dev root instead. Neither total is the whole artifact bill on its own — read both before deciding how much of a round is real.',
            '',
          );
        }
        lines.push(
          '_Attribution is by IMMEDIATE dominator and uses SELF size, so the rows partition the heap and sum to the total above. An owner growing does not prove a leak — a cache filling legitimately looks identical here; use `memlab_dominator_chain` on an instance to find the accountable application object, and a ladder (`memlab_leak_report`) to tell filling from unbounded growth._',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
