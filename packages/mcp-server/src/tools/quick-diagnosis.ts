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
import type {IHeapNode, HeapNodeIdSet} from '@memlab/core';
import memlabCore from '@memlab/core';
const {utils, NumericSet} = memlabCore;
import {z} from 'zod';
import {
  getSnapshot,
  getSnapshotMetadata,
  getSnapshotEnv,
} from '../heap-state.js';
import {
  isNodeWorthInspecting,
  filterLargestObjects,
  truncateNodeName,
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';

function sanitizeForTable(s: string): string {
  return s.replace(/[\n\r\t]/g, ' ').replace(/\|/g, '¦');
}

function getContentPreview(node: IHeapNode): string {
  if (node.isString) {
    const strNode = node.toStringNode();
    if (strNode) {
      const val = strNode.stringValue;
      const preview = val.length > 40 ? val.slice(0, 40) + '…' : val;
      return sanitizeForTable(preview);
    }
  }
  const props: string[] = [];
  for (const edge of node.references) {
    if (
      edge.type === 'property' ||
      edge.type === 'element' ||
      edge.type === 'shortcut'
    ) {
      props.push(String(edge.name_or_index));
      if (props.length >= 3) break;
    }
  }
  if (props.length > 0) {
    const more = node.edge_count > props.length ? ', …' : '';
    return `{${props.join(', ')}${more}}`;
  }
  return '';
}

export function registerQuickDiagnosis(server: McpServer): void {
  server.tool(
    'memlab_quick_diagnosis',
    'Combined diagnosis tool that returns snapshot summary, top objects by retained size, class histogram, and duplicated strings in a single call. Saves 3-4 round trips and reduces token overhead from repeated headers. Use this as the first analysis tool after memlab_load_snapshot for an immediate comprehensive overview. ' +
      'By DEFAULT every section runs in a single O(N) pass (the class histogram reports retained size as a lower/upper-bound range rather than the exact dominator-deduped value), so it is safe on large heaps. Pass `exact_retained_size:true` ONLY when the user explicitly wants exact per-class retained sizes — that adds a per-class dominator walk that can stall or OOM the server on snapshots with millions of nodes.',
    {
      top_objects: z
        .number()
        .optional()
        .default(10)
        .describe('Number of largest objects to include (default 10)'),
      top_classes: z
        .number()
        .optional()
        .default(15)
        .describe('Number of top classes in histogram (default 15)'),
      top_strings: z
        .number()
        .optional()
        .default(10)
        .describe('Number of top duplicated strings (default 10)'),
      exact_retained_size: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Compute EXACT dominator-deduped retained size for the class histogram via aggregateDominatorMetrics. DEFAULT false: the class histogram shows a retained-size range (lower = self size, upper = Σ raw retained) computed in the O(N) pass. Set true ONLY on explicit user request — the exact walk can be very slow or time out on huge heaps.',
        ),
    },
    async ({top_objects, top_classes, top_strings, exact_retained_size}) => {
      try {
        const snapshot = getSnapshot();
        const meta = getSnapshotMetadata();
        const env = getSnapshotEnv();

        // --- Section 1: Summary ---
        let nodeCount = 0;
        let totalSelfSize = 0;
        let edgeCount = 0;
        const typeStats = new Map<string, {count: number; self_size: number}>();

        snapshot.nodes.forEach(node => {
          nodeCount++;
          totalSelfSize += node.self_size;
          const stats = typeStats.get(node.type);
          if (stats) {
            stats.count++;
            stats.self_size += node.self_size;
          } else {
            typeStats.set(node.type, {count: 1, self_size: node.self_size});
          }
        });
        snapshot.edges.forEach(() => {
          edgeCount++;
        });

        const envLabel =
          env === 'browser'
            ? 'Browser'
            : env === 'node'
              ? 'Node.js'
              : 'Unknown';

        const lines: string[] = [
          `# Quick Diagnosis`,
          '',
          `**Snapshot:** ${meta?.fileName ?? 'unknown'} | **Nodes:** ${formatNumber(nodeCount)} | **Edges:** ${formatNumber(edgeCount)} | **Size:** ${formatBytes(totalSelfSize)} | **Env:** ${envLabel}`,
          '',
        ];

        // Type breakdown (compact — self size only, no dominator walk)
        const typeSorted = [...typeStats.entries()].sort(
          (a, b) => b[1].self_size - a[1].self_size,
        );
        const typeHeaders = ['Type', 'Count', 'Self Size'];
        const typeRightCols = new Set([1, 2]);
        const typeRows = typeSorted.map(([type, stats]) => [
          type,
          formatNumber(stats.count),
          formatBytes(stats.self_size),
        ]);
        lines.push(
          '## Type Breakdown',
          '',
          markdownTable(typeHeaders, typeRows, typeRightCols),
          '',
        );

        // --- Section 2: Largest Objects ---
        const largest = filterLargestObjects(
          snapshot,
          (node: IHeapNode) => isNodeWorthInspecting(node),
          top_objects,
        );

        const objHeaders = ['ID', 'Name', 'Type', 'Retained', 'Preview'];
        const objRightCols = new Set([3]);
        const objRows = largest.map(n => [
          `@${n.id}`,
          truncateNodeName(n.name, n.type, n.self_size, 50),
          n.type,
          formatBytes(n.retainedSize),
          getContentPreview(n),
        ]);
        lines.push(
          `## Top ${objRows.length} Objects by Retained Size`,
          '',
          markdownTable(objHeaders, objRows, objRightCols),
          '',
        );

        // --- Section 3: Class Histogram ---
        const classMap = new Map<
          string,
          {
            count: number;
            total_self_size: number;
            raw_retained: number;
            node_ids: HeapNodeIdSet | null;
            type: string;
          }
        >();

        snapshot.nodes.forEach(node => {
          if (node.id <= 3) return;
          const key = `${node.type}::${node.name}`;
          const entry = classMap.get(key);
          if (entry) {
            entry.count++;
            entry.total_self_size += node.self_size;
            entry.raw_retained += node.retainedSize;
            if (entry.node_ids) entry.node_ids.add(node.id);
          } else {
            classMap.set(key, {
              count: 1,
              total_self_size: node.self_size,
              raw_retained: node.retainedSize,
              // Per-node ids are only needed for the opt-in exact dominator walk.
              node_ids: exact_retained_size ? new NumericSet([node.id]) : null,
              type: node.type,
            });
          }
        });

        const classEntries = [...classMap.entries()].filter(
          ([, v]) => v.count >= 1,
        );

        // By DEFAULT skip the exact dominator walk (the part that stalls the
        // server on huge heaps) and rank by the upper-bound raw retained sum;
        // only compute exact dominator-deduped retained when explicitly asked.
        const withRetained = classEntries.map(([key, v]) => {
          let exact: number | null = null;
          if (exact_retained_size && v.node_ids) {
            exact = utils.aggregateDominatorMetrics(
              v.node_ids,
              snapshot,
              () => true,
              (node: IHeapNode) => node.retainedSize,
            );
          }
          const rank = exact ?? v.raw_retained;
          return {key, ...v, exact, rank};
        });

        const totalClassRetained = meta?.totalSize ?? 0;

        const classSorted = withRetained
          .sort((a, b) => b.rank - a.rank)
          .slice(0, top_classes);
        const classHeaders = exact_retained_size
          ? ['Class', 'Type', 'Count', 'Retained', '% Heap']
          : ['Class', 'Type', 'Count', 'Retained ≤ (upper)', '% Heap ≤'];
        const classRightCols = new Set([2, 3, 4]);
        const classRows = classSorted.map(v => {
          const rawName = v.key.split('::').slice(1).join('::');
          const name = truncateNodeName(
            rawName,
            v.type,
            Math.round(v.total_self_size / v.count),
            80,
          );
          const pctNum =
            totalClassRetained > 0 ? (v.rank / totalClassRetained) * 100 : null;
          // The exact (dominator-deduped) % can never exceed 100%. The
          // upper-bound % can, because raw_retained double-counts shared
          // subtrees — render that as ">100%" instead of a nonsensical figure
          // like "1253%" (feedback §A.3).
          const exactPct = pctNum == null ? '-' : `${pctNum.toFixed(1)}%`;
          const upperPct =
            pctNum == null
              ? '-'
              : pctNum > 100
                ? '>100%'
                : `${pctNum.toFixed(1)}%`;
          return [
            name,
            v.type,
            formatNumber(v.count),
            exact_retained_size
              ? formatBytes(v.exact ?? 0)
              : `≤ ${formatBytes(v.raw_retained)}`,
            exact_retained_size ? exactPct : `≤ ${upperPct}`,
          ];
        });
        lines.push(
          `## Class Histogram (top ${classRows.length})`,
          '',
          markdownTable(classHeaders, classRows, classRightCols),
          '',
        );
        if (!exact_retained_size) {
          lines.push(
            "_Class `Retained` is an **upper bound** (Σ each instance's retained size, which double-counts shared subtrees); the lower bound is the class self size. The exact dominator-deduped value needs a per-class dominator walk (slow / can time out on large heaps) — pass `exact_retained_size:true` for it._",
            '',
          );
        }

        // --- Section 4: Duplicated Strings ---
        const stringMap = new Map<
          string,
          {count: number; total_size: number}
        >();

        snapshot.nodes.forEach(node => {
          if (node.type !== 'string') return;
          if (node.name === 'system / SlicedString') return;
          const strNode = node.toStringNode();
          if (!strNode) return;
          const value = strNode.stringValue;
          const entry = stringMap.get(value);
          if (entry) {
            entry.count++;
            entry.total_size += node.retainedSize;
          } else {
            stringMap.set(value, {count: 1, total_size: node.retainedSize});
          }
        });

        const duplicated = Array.from(stringMap.entries())
          .filter(([, stats]) => stats.count >= 2)
          .sort((a, b) => b[1].total_size - a[1].total_size)
          .slice(0, top_strings);

        if (duplicated.length > 0) {
          const strHeaders = ['Value', 'Copies', 'Total Size', 'Savings'];
          const strRightCols = new Set([1, 2, 3]);
          const strRows = duplicated.map(([value, stats]) => {
            const display =
              value.length > 50 ? value.slice(0, 50) + '…' : value;
            const perCopy =
              stats.count > 0 ? stats.total_size / stats.count : 0;
            const savings = (stats.count - 1) * perCopy;
            return [
              sanitizeForTable(display),
              formatNumber(stats.count),
              formatBytes(stats.total_size),
              formatBytes(savings),
            ];
          });

          const totalDupSavings = duplicated.reduce((sum, [, stats]) => {
            const perCopy =
              stats.count > 0 ? stats.total_size / stats.count : 0;
            return sum + (stats.count - 1) * perCopy;
          }, 0);

          lines.push(
            `## Duplicated Strings (top ${strRows.length})`,
            '',
            markdownTable(strHeaders, strRows, strRightCols),
            '',
            `**Total interning savings: ${formatBytes(totalDupSavings)}** (if each string stored once)`,
            '',
          );
        }

        // --- Section 5: String-to-Object Ratio Flag (Feedback #11) ---
        const stringCount = typeStats.get('string')?.count ?? 0;
        const objectCount = typeStats.get('object')?.count ?? 0;
        const heavyDupCount = duplicated.filter(
          ([, stats]) => stats.count >= 100_000,
        ).length;

        if (
          objectCount > 0 &&
          stringCount / objectCount > 2 &&
          heavyDupCount > 0
        ) {
          const ratio = (stringCount / objectCount).toFixed(1);
          lines.push(
            '## ⚠️ High String Duplication Ratio',
            '',
            `**${formatNumber(stringCount)} strings / ${formatNumber(objectCount)} objects = ${ratio}:1 ratio** with ${heavyDupCount} string(s) having >100K copies.`,
            '',
            'This pattern strongly indicates JSON.parse output or API response data where column values are not interned. String interning at the parse boundary could save significant memory.',
            '',
            '**Next step:** `memlab_intern_opportunities` to see savings grouped by property × parent shape.',
            '',
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
