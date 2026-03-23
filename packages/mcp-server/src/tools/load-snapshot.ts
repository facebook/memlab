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
import memlabHeapAnalysis from '@memlab/heap-analysis';
const {getFullHeapFromFile} = memlabHeapAnalysis;
import {setSnapshot} from '../heap-state.js';
import {formatBytes, formatNumber, errorResult, textResult} from '../utils.js';

export function registerLoadSnapshot(server: McpServer): void {
  server.tool(
    'memlab_load_snapshot',
    'Load and parse a .heapsnapshot file. This builds indexes, computes the dominator tree, and calculates retained sizes. Only one snapshot can be loaded at a time.',
    {
      file_path: z.string().describe('Absolute path to a .heapsnapshot file'),
    },
    async ({file_path}) => {
      try {
        const snapshot = await getFullHeapFromFile(file_path);
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

        return textResult(
          `Loaded ${file_path}: ${formatNumber(nodeCount)} nodes, ${formatNumber(edgeCount)} edges, ${formatBytes(totalSize)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
