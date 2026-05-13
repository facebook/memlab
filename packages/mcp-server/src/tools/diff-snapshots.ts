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
import type {IHeapSnapshot} from '@memlab/core';
import fs from 'fs';
import path from 'path';
import {z} from 'zod';
import memlabHeapAnalysis from '@memlab/heap-analysis';
const {getFullHeapFromFile} = memlabHeapAnalysis;
import {setSnapshot} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  textResult,
} from '../utils.js';

interface ClassStats {
  count: number;
  self_size: number;
}

function buildHistogram(snapshot: IHeapSnapshot): Map<string, ClassStats> {
  const map = new Map<string, ClassStats>();
  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;
    const key = `${node.type}::${node.name}`;
    const entry = map.get(key);
    if (entry) {
      entry.count++;
      entry.self_size += node.self_size;
    } else {
      map.set(key, {count: 1, self_size: node.self_size});
    }
  });
  return map;
}

export function registerDiffSnapshots(server: McpServer): void {
  server.tool(
    'memlab_diff_snapshots',
    'Compare two heap snapshots by class histogram. Shows classes that grew, shrunk, appeared, or disappeared between "before" and "after" snapshots. The "after" snapshot becomes the active snapshot for subsequent analysis.',
    {
      before_path: z
        .string()
        .describe('Absolute path to the "before" .heapsnapshot file'),
      after_path: z
        .string()
        .describe('Absolute path to the "after" .heapsnapshot file'),
      limit: z
        .number()
        .optional()
        .default(30)
        .describe('Maximum rows per section (default 30)'),
      min_count_delta: z
        .number()
        .optional()
        .default(0)
        .describe(
          'Minimum absolute change in instance count to show (default 0). Use to filter noise.',
        ),
      min_size_delta: z
        .number()
        .optional()
        .default(0)
        .describe(
          'Minimum absolute change in self size (bytes) to show (default 0).',
        ),
    },
    async ({
      before_path,
      after_path,
      limit,
      min_count_delta,
      min_size_delta,
    }) => {
      try {
        const resolvedBefore = path.resolve(before_path);
        const resolvedAfter = path.resolve(after_path);

        if (!fs.existsSync(resolvedBefore)) {
          return errorResult(
            new Error(`Before file not found: ${resolvedBefore}`),
          );
        }
        if (!fs.existsSync(resolvedAfter)) {
          return errorResult(
            new Error(`After file not found: ${resolvedAfter}`),
          );
        }

        const [beforeSnapshot, afterSnapshot] = await Promise.all([
          getFullHeapFromFile(resolvedBefore),
          getFullHeapFromFile(resolvedAfter),
        ]);
        const beforeHist = buildHistogram(beforeSnapshot);
        const afterHist = buildHistogram(afterSnapshot);
        setSnapshot(afterSnapshot, after_path);

        // Compute deltas
        const allKeys = new Set([...beforeHist.keys(), ...afterHist.keys()]);

        interface DiffEntry {
          key: string;
          name: string;
          type: string;
          before_count: number;
          after_count: number;
          count_delta: number;
          before_size: number;
          after_size: number;
          size_delta: number;
        }

        const diffs: DiffEntry[] = [];
        for (const key of allKeys) {
          const before = beforeHist.get(key);
          const after = afterHist.get(key);
          const bc = before?.count ?? 0;
          const ac = after?.count ?? 0;
          const bs = before?.self_size ?? 0;
          const as_ = after?.self_size ?? 0;
          const countDelta = ac - bc;
          const sizeDelta = as_ - bs;

          if (
            Math.abs(countDelta) < min_count_delta ||
            Math.abs(sizeDelta) < min_size_delta
          ) {
            continue;
          }

          const parts = key.split('::');
          diffs.push({
            key,
            name: parts.slice(1).join('::'),
            type: parts[0],
            before_count: bc,
            after_count: ac,
            count_delta: countDelta,
            before_size: bs,
            after_size: as_,
            size_delta: sizeDelta,
          });
        }

        const grew = diffs
          .filter(d => d.count_delta > 0)
          .sort((a, b) => b.count_delta - a.count_delta);
        const shrunk = diffs
          .filter(d => d.count_delta < 0)
          .sort((a, b) => a.count_delta - b.count_delta);

        const lines: string[] = [];

        // Overall summary
        let totalBeforeNodes = 0;
        let totalBeforeSize = 0;
        let totalAfterNodes = 0;
        let totalAfterSize = 0;
        beforeHist.forEach(v => {
          totalBeforeNodes += v.count;
          totalBeforeSize += v.self_size;
        });
        afterHist.forEach(v => {
          totalAfterNodes += v.count;
          totalAfterSize += v.self_size;
        });

        const nodeDelta = totalAfterNodes - totalBeforeNodes;
        const sizeDelta = totalAfterSize - totalBeforeSize;
        const sign = (n: number) => (n >= 0 ? '+' : '-');

        lines.push('## Snapshot Comparison');
        lines.push('');
        lines.push(`| | Before | After | Delta |`);
        lines.push(`|---|---:|---:|---:|`);
        lines.push(
          `| Nodes | ${formatNumber(totalBeforeNodes)} | ${formatNumber(totalAfterNodes)} | ${sign(nodeDelta)}${formatNumber(Math.abs(nodeDelta))} |`,
        );
        lines.push(
          `| Self Size | ${formatBytes(totalBeforeSize)} | ${formatBytes(totalAfterSize)} | ${sign(sizeDelta)}${formatBytes(Math.abs(sizeDelta))} |`,
        );
        lines.push('');

        // Grew section
        if (grew.length > 0) {
          const headers = [
            'Class',
            'Type',
            'Before',
            'After',
            'Δ Count',
            'Δ Size',
          ];
          const rightCols = new Set([2, 3, 4, 5]);
          const rows = grew
            .slice(0, limit)
            .map(d => [
              d.name,
              d.type,
              formatNumber(d.before_count),
              formatNumber(d.after_count),
              `+${formatNumber(d.count_delta)}`,
              `${sign(d.size_delta)}${formatBytes(Math.abs(d.size_delta))}`,
            ]);
          lines.push(
            `### Classes that grew (${formatNumber(grew.length)} total, showing ${rows.length})`,
          );
          lines.push('');
          lines.push(markdownTable(headers, rows, rightCols));
          lines.push('');
        }

        // Shrunk section
        if (shrunk.length > 0) {
          const headers = [
            'Class',
            'Type',
            'Before',
            'After',
            'Δ Count',
            'Δ Size',
          ];
          const rightCols = new Set([2, 3, 4, 5]);
          const rows = shrunk
            .slice(0, limit)
            .map(d => [
              d.name,
              d.type,
              formatNumber(d.before_count),
              formatNumber(d.after_count),
              formatNumber(d.count_delta),
              `${sign(d.size_delta)}${formatBytes(Math.abs(d.size_delta))}`,
            ]);
          lines.push(
            `### Classes that shrunk (${formatNumber(shrunk.length)} total, showing ${rows.length})`,
          );
          lines.push('');
          lines.push(markdownTable(headers, rows, rightCols));
          lines.push('');
        }

        if (grew.length === 0 && shrunk.length === 0) {
          lines.push(
            'No significant differences found between the two snapshots.',
          );
        }

        lines.push(
          `\n*The "after" snapshot is now active for further analysis.*`,
        );

        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
