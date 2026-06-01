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
import {setSnapshot, getSnapshotMetadata} from '../heap-state.js';
import type {SnapshotEnv} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  truncateNodeName,
  errorResult,
  textResult,
} from '../utils.js';

interface LargestObjInfo {
  id: number;
  name: string;
  size: number;
  type: string;
}

function findLargestObject(snapshot: IHeapSnapshot): LargestObjInfo | null {
  let best: LargestObjInfo | null = null;
  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;
    if (
      node.type === 'object' ||
      node.type === 'closure' ||
      node.type === 'regexp'
    ) {
      if (!best || node.retainedSize > best.size) {
        best = {
          id: node.id,
          name: node.name,
          size: node.retainedSize,
          type: node.type,
        };
      }
    }
  });
  return best;
}

function detectEnv(snapshot: IHeapSnapshot): SnapshotEnv {
  let hasWindow = false;
  let hasModule = false;
  snapshot.nodes.forEach(node => {
    if (hasWindow) return;
    if (node.name.startsWith('Window ') && node.type === 'object') {
      hasWindow = true;
    }
    if (
      node.name === 'Module' &&
      node.type === 'object' &&
      !hasWindow &&
      !hasModule
    ) {
      hasModule = true;
    }
  });
  if (hasWindow) return 'browser';
  if (hasModule) return 'node';
  return 'unknown';
}

function quickDiagnosis(
  snapshot: IHeapSnapshot,
  totalSelfSize: number,
): string[] {
  const warnings: string[] = [];

  const largeStrings: {id: number; name: string; size: number}[] = [];
  const stringCounts = new Map<string, number>();
  const classCounts = new Map<string, number>();

  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;

    if (node.type === 'string' && node.self_size >= 1024 * 1024) {
      largeStrings.push({id: node.id, name: node.name, size: node.self_size});
    }

    if (node.type === 'string' && node.name !== 'system / SlicedString') {
      const key = node.name.length > 100 ? node.name.slice(0, 100) : node.name;
      stringCounts.set(key, (stringCounts.get(key) ?? 0) + 1);
    }

    if (node.type !== 'hidden' && node.type !== 'array') {
      classCounts.set(node.name, (classCounts.get(node.name) ?? 0) + 1);
    }
  });

  if (largeStrings.length > 0) {
    const totalSize = largeStrings.reduce((s, n) => s + n.size, 0);
    warnings.push(
      `⚠ ${largeStrings.length} string(s) > 1 MB (${formatBytes(totalSize)} total) — possible unbounded data retention`,
    );
  }

  const highDups = [...stringCounts.entries()]
    .filter(([, count]) => count >= 1000)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  for (const [val, count] of highDups) {
    const display = val.length > 40 ? val.slice(0, 40) + '…' : val;
    warnings.push(`⚠ "${display}" duplicated ${formatNumber(count)} times`);
  }

  const largest = findLargestObject(snapshot);
  if (largest && totalSelfSize > 0) {
    const pct = ((largest.size / totalSelfSize) * 100).toFixed(0);
    if (largest.size >= totalSelfSize * 0.3) {
      warnings.push(
        `⚠ @${largest.id} ${truncateNodeName(largest.name, largest.type, largest.size, 40)} (${largest.type}) retains ${formatBytes(largest.size)} (${pct}% of heap)`,
      );
    }
  }

  const anomalous = [...classCounts.entries()]
    .filter(([, count]) => count >= 10000)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  for (const [name, count] of anomalous) {
    warnings.push(`⚠ ${formatNumber(count)}× \`${name}\` instances`);
  }

  if (warnings.length > 0) {
    warnings.push(
      '',
      'Run `memlab_quick_diagnosis` for actionable triage or `memlab_auto_investigate` for deep analysis.',
    );
  }

  return warnings;
}

export function registerLoadSnapshot(server: McpServer): void {
  server.tool(
    'memlab_load_snapshot',
    'Load and parse a .heapsnapshot file. This builds indexes, computes the dominator tree, and calculates retained sizes. Returns a quick diagnosis highlighting potential issues. Only one snapshot can be loaded at a time.',
    {
      file_path: z.string().describe('Absolute path to a .heapsnapshot file'),
    },
    async ({file_path}) => {
      try {
        const previousMeta = getSnapshotMetadata();
        const resolved = path.resolve(file_path);
        if (!fs.existsSync(resolved)) {
          return errorResult(new Error(`File not found: ${resolved}`));
        }
        const fileStat = fs.statSync(resolved);
        const fileSizeMB = fileStat.size / (1024 * 1024);
        if (fileSizeMB > 200) {
          process.stderr.write(
            `Loading ${formatBytes(fileStat.size)} snapshot — this may take a while (parsing, computing dominators, building indexes)...\n`,
          );
        }
        const snapshot = await getFullHeapFromFile(resolved);

        let nodeCount = 0;
        let edgeCount = 0;
        let totalSize = 0;
        snapshot.nodes.forEach(node => {
          nodeCount++;
          totalSize += node.self_size;
        });
        snapshot.edges.forEach(() => {
          edgeCount++;
        });

        const env = detectEnv(snapshot);
        const fileName = path.basename(file_path);
        setSnapshot(snapshot, file_path, {
          fileName,
          nodeCount,
          edgeCount,
          totalSize,
          env,
        });

        const envLabel =
          env === 'browser'
            ? 'Browser'
            : env === 'node'
              ? 'Node.js'
              : 'Unknown';
        const lines: string[] = [];
        if (previousMeta) {
          lines.push(
            `⚠ Replacing previously loaded snapshot "${previousMeta.fileName}"`,
          );
        }
        lines.push(
          `Loaded ${file_path} (${formatBytes(fileStat.size)} on disk): ${formatNumber(nodeCount)} nodes, ${formatNumber(edgeCount)} edges, ${formatBytes(totalSize)} heap size (${envLabel} snapshot)`,
        );

        const warnings = quickDiagnosis(snapshot, totalSize);
        if (warnings.length > 0) {
          lines.push('', ...warnings);
        }

        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
