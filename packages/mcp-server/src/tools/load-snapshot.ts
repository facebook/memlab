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
  truncateNodeName,
  errorResult,
  textResult,
} from '../utils.js';

function quickDiagnosis(
  snapshot: IHeapSnapshot,
  totalSelfSize: number,
): string[] {
  const warnings: string[] = [];

  // Track large strings (> 1 MB)
  const largeStrings: {id: number; name: string; size: number}[] = [];
  // Track high-duplication strings
  const stringCounts = new Map<string, number>();
  // Track largest single objects
  let largestObj: {
    id: number;
    name: string;
    size: number;
    type: string;
  } | null = null;
  // Track class counts for anomaly detection
  const classCounts = new Map<string, number>();

  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;

    // Large strings
    if (node.type === 'string' && node.self_size >= 1024 * 1024) {
      largeStrings.push({id: node.id, name: node.name, size: node.self_size});
    }

    // String duplication (sample by name for speed)
    if (node.type === 'string' && node.name !== 'system / SlicedString') {
      const key = node.name.length > 100 ? node.name.slice(0, 100) : node.name;
      stringCounts.set(key, (stringCounts.get(key) ?? 0) + 1);
    }

    // Largest retained object (skip internal types)
    if (
      node.type === 'object' ||
      node.type === 'closure' ||
      node.type === 'regexp'
    ) {
      if (!largestObj || node.retainedSize > largestObj.size) {
        largestObj = {
          id: node.id,
          name: node.name,
          size: node.retainedSize,
          type: node.type,
        };
      }
    }

    // Class counts (for anomaly detection)
    if (node.type !== 'hidden' && node.type !== 'array') {
      classCounts.set(node.name, (classCounts.get(node.name) ?? 0) + 1);
    }
  });

  // Report large strings
  if (largeStrings.length > 0) {
    const totalSize = largeStrings.reduce((s, n) => s + n.size, 0);
    warnings.push(
      `⚠ ${largeStrings.length} string(s) > 1 MB (${formatBytes(totalSize)} total) — possible unbounded data retention`,
    );
  }

  // Report high duplication
  const highDups = [...stringCounts.entries()]
    .filter(([, count]) => count >= 1000)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  for (const [val, count] of highDups) {
    const display = val.length > 40 ? val.slice(0, 40) + '…' : val;
    warnings.push(`⚠ "${display}" duplicated ${formatNumber(count)} times`);
  }

  // Report if single object dominates heap
  if (largestObj) {
    const pct = ((largestObj.size / totalSelfSize) * 100).toFixed(0);
    if (largestObj.size >= totalSelfSize * 0.3) {
      warnings.push(
        `⚠ @${largestObj.id} ${truncateNodeName(largestObj.name, largestObj.type, largestObj.size, 40)} (${largestObj.type}) retains ${formatBytes(largestObj.size)} (${pct}% of heap)`,
      );
    }
  }

  // Report anomalous class counts
  const anomalous = [...classCounts.entries()]
    .filter(([, count]) => count >= 10000)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  for (const [name, count] of anomalous) {
    warnings.push(`⚠ ${formatNumber(count)}× \`${name}\` instances`);
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
        const resolved = path.resolve(file_path);
        if (!fs.existsSync(resolved)) {
          return errorResult(new Error(`File not found: ${resolved}`));
        }
        const snapshot = await getFullHeapFromFile(resolved);
        setSnapshot(snapshot, file_path);

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

        const lines = [
          `Loaded ${file_path}: ${formatNumber(nodeCount)} nodes, ${formatNumber(edgeCount)} edges, ${formatBytes(totalSize)}`,
        ];

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
