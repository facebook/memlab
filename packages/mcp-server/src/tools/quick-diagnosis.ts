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
    'Combined diagnosis tool that returns snapshot summary, top objects by retained size, class histogram, and duplicated strings in a single call. Saves 3-4 round trips and reduces token overhead from repeated headers. Use this as the first analysis tool after memlab_load_snapshot for an immediate comprehensive overview.',
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
    },
    async ({top_objects, top_classes, top_strings}) => {
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
            node_ids: HeapNodeIdSet;
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
            entry.node_ids.add(node.id);
          } else {
            classMap.set(key, {
              count: 1,
              total_self_size: node.self_size,
              node_ids: new NumericSet([node.id]),
              type: node.type,
            });
          }
        });

        const classEntries = [...classMap.entries()].filter(
          ([, v]) => v.count >= 1,
        );

        const withRetained = classEntries.map(([key, v]) => {
          const retainedSize = utils.aggregateDominatorMetrics(
            v.node_ids,
            snapshot,
            () => true,
            (node: IHeapNode) => node.retainedSize,
          );
          return {key, ...v, retained_size: retainedSize};
        });

        // Use total heap size as denominator so cumulative % reflects each
        // class's share of the entire heap, not just the displayed classes.
        const totalClassRetained = meta?.totalSize ?? 0;

        const classSorted = withRetained
          .sort((a, b) => b.retained_size - a.retained_size)
          .slice(0, top_classes);
        let cumRetained = 0;
        const classHeaders = ['Class', 'Type', 'Count', 'Retained', 'Cum %'];
        const classRightCols = new Set([2, 3, 4]);
        const classRows = classSorted.map(v => {
          const rawName = v.key.split('::').slice(1).join('::');
          const name = truncateNodeName(
            rawName,
            v.type,
            Math.round(v.total_self_size / v.count),
            80,
          );
          cumRetained += v.retained_size;
          const cumPct =
            totalClassRetained > 0
              ? ((cumRetained / totalClassRetained) * 100).toFixed(1) + '%'
              : '-';
          return [
            name,
            v.type,
            formatNumber(v.count),
            formatBytes(v.retained_size),
            cumPct,
          ];
        });
        lines.push(
          `## Class Histogram (top ${classRows.length})`,
          '',
          markdownTable(classHeaders, classRows, classRightCols),
          '',
        );

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
          const strHeaders = ['Value', 'Copies', 'Total Size'];
          const strRightCols = new Set([1, 2]);
          const strRows = duplicated.map(([value, stats]) => {
            const display =
              value.length > 50 ? value.slice(0, 50) + '…' : value;
            return [
              sanitizeForTable(display),
              formatNumber(stats.count),
              formatBytes(stats.total_size),
            ];
          });
          lines.push(
            `## Duplicated Strings (top ${strRows.length})`,
            '',
            markdownTable(strHeaders, strRows, strRightCols),
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
