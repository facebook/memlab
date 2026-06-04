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
import {getSnapshot, getSnapshotMetadata} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';

type KeyPattern = 'sequential-int' | 'timestamp' | 'monotonic-string' | 'mixed';

interface GrowthCandidate {
  nodeId: number;
  kind: string;
  entryCount: number;
  retainedSize: number;
  pattern: KeyPattern;
  sample: string;
}

const NOW_MS = 1_700_000_000_000; // ~2023; lower bound for plausible ms epoch
const FUTURE_MS = 4_100_000_000_000; // ~2099; upper bound

function looksLikeTimestamp(n: number): boolean {
  // ms epoch
  if (n >= NOW_MS && n <= FUTURE_MS) return true;
  // s epoch
  if (n >= NOW_MS / 1000 && n <= FUTURE_MS / 1000) return true;
  return false;
}

function classifyKeys(keys: string[]): KeyPattern | null {
  if (keys.length < 3) return null;
  const nums = keys.map(k => Number(k)).filter(n => Number.isFinite(n));
  if (nums.length < keys.length * 0.8) return null; // mostly non-numeric → skip

  const sorted = [...nums].sort((a, b) => a - b);
  if (sorted.every(n => looksLikeTimestamp(n))) return 'timestamp';

  // sequential / monotonic integers (consecutive-ish)
  let consecutive = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] <= 2) consecutive++;
  }
  if (consecutive >= (sorted.length - 1) * 0.7) {
    return Number.isInteger(sorted[0]) && sorted[0] >= 0
      ? 'sequential-int'
      : 'monotonic-string';
  }
  return null;
}

function sampleMapKeys(node: IHeapNode, max: number): string[] {
  const keys: string[] = [];
  for (const edge of node.references) {
    const n = String(edge.name_or_index);
    if (
      (n === 'table' || n === 'backing_store') &&
      (edge.toNode.type === 'array' || edge.toNode.type === 'hidden')
    ) {
      const refs: IHeapNode[] = [];
      for (const te of edge.toNode.references) refs.push(te.toNode);
      const step = node.name === 'Map' ? 2 : 1;
      for (let i = 0; i < refs.length && keys.length < max; i += step) {
        const k = refs[i];
        if (!k || k.id <= 3) continue;
        if (k.name === 'undefined' || k.name === 'the_hole') continue;
        if (k.isString) {
          const s = k.toStringNode();
          keys.push(s ? s.stringValue : k.name);
        } else if (k.name === 'smi number' && k.self_size === 0) {
          keys.push(String(k.id >> 1));
        }
      }
      break;
    }
  }
  return keys;
}

export function registerGrowthSignals(server: McpServer): void {
  server.tool(
    'memlab_growth_signals',
    'Heuristically flag collections that look like they grow without bound, from a SINGLE snapshot (no baseline needed). Detects Maps/Sets keyed by timestamps or sequential integers (time-series / append-only logs) and large ever-growing Arrays. Use when you have only one snapshot and want to guess what is accumulating, before confirming with a diff against a later capture.',
    {
      limit: z
        .number()
        .optional()
        .default(15)
        .describe('Maximum number of candidates to return (default 15).'),
      min_entries: z
        .number()
        .optional()
        .default(200)
        .describe('Minimum entry/element count to consider (default 200).'),
      min_retained_size: z
        .number()
        .optional()
        .default(262144)
        .describe('Minimum retained size in bytes (default 256 KB).'),
    },
    async ({limit, min_entries, min_retained_size}) => {
      try {
        const snapshot = getSnapshot();
        const meta = getSnapshotMetadata();
        const totalSize = meta?.totalSize ?? 0;
        const candidates: GrowthCandidate[] = [];

        const insert = (c: GrowthCandidate) => {
          let i = 0;
          for (; i < candidates.length; i++) {
            if (c.retainedSize > candidates[i].retainedSize) break;
          }
          candidates.splice(i, 0, c);
          if (candidates.length > limit) candidates.length = limit;
        };

        snapshot.nodes.forEach(node => {
          if (node.id <= 3 || node.type !== 'object') return;
          if (node.retainedSize < min_retained_size) return;

          if (node.name === 'Map' || node.name === 'Set') {
            const keys = sampleMapKeys(node, 60);
            // Use the larger of sampled count and a table-based estimate.
            if (keys.length < 3) return;
            const pattern = classifyKeys(keys);
            if (!pattern) return;
            // Estimate entries from edge_count of the table.
            let entries = keys.length;
            for (const edge of node.references) {
              const n = String(edge.name_or_index);
              if (n === 'table' || n === 'backing_store') {
                entries = Math.max(
                  entries,
                  node.name === 'Map'
                    ? Math.floor(edge.toNode.edge_count / 2)
                    : edge.toNode.edge_count,
                );
                break;
              }
            }
            if (entries < min_entries) return;
            insert({
              nodeId: node.id,
              kind: `${node.name} (${pattern === 'timestamp' ? 'time-keyed' : 'sequentially-keyed'})`,
              entryCount: entries,
              retainedSize: node.retainedSize,
              pattern,
              sample: keys.slice(0, 3).join(', '),
            });
          } else if (node.name === 'Array') {
            const count = node.edge_count;
            if (count < min_entries) return;
            // Heuristic: large dense arrays are append-only growth candidates.
            insert({
              nodeId: node.id,
              kind: 'Array (append-only candidate)',
              entryCount: count,
              retainedSize: node.retainedSize,
              pattern: 'sequential-int',
              sample: `${formatNumber(count)} elements`,
            });
          }
        });

        if (candidates.length === 0) {
          return toolResult(
            `No growth signals found (no timestamp/sequentially-keyed collections or large arrays >= ${formatNumber(min_entries)} entries and >= ${formatBytes(min_retained_size)}). This is a single-snapshot heuristic — capture a second snapshot later and use memlab_diff_snapshots to confirm actual growth.`,
          );
        }

        const headers = [
          'ID',
          'Kind',
          'Entries',
          'Retained',
          '% Heap',
          'Sample keys',
        ];
        const rightCols = new Set([2, 3, 4]);
        const rows = candidates.map(c => [
          `@${c.nodeId}`,
          c.kind,
          formatNumber(c.entryCount),
          formatBytes(c.retainedSize),
          totalSize > 0
            ? Math.min(100, (c.retainedSize / totalSize) * 100).toFixed(1) + '%'
            : '-',
          c.sample.length > 40 ? c.sample.slice(0, 37) + '…' : c.sample,
        ]);

        const lines = [
          `## Growth Signals (single-snapshot heuristic)`,
          '',
          `${candidates.length} collection(s) that look like unbounded accumulation:`,
          '',
          markdownTable(headers, rows, rightCols),
          '',
          '_Heuristic only — timestamp/sequential keys and large dense arrays *suggest* append-only growth but do not prove it. Confirm by capturing a later snapshot and running `memlab_diff_snapshots`, or trace one with `memlab_retainer_trace` to see what keeps it alive._',
        ];

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
