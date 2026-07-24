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
import {getSnapshot} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  truncateNodeName,
  errorResult,
  toolResult,
  enumerateMapEntries,
  enumerateSetElements,
} from '../utils.js';

// Render a node as a short label, inlining the string value for string nodes so
// cache keys are visible verbatim (the whole point of enumerating a cache Map).
function describeNode(node: IHeapNode, maxLen: number): string {
  if (node.isString) {
    const strNode = node.toStringNode();
    if (strNode) {
      const val = strNode.stringValue;
      const shown = val.length > maxLen ? val.slice(0, maxLen) + '...' : val;
      return `"${shown}"`;
    }
  }
  return `${truncateNodeName(node.name, node.type, node.self_size, maxLen)} (${node.type})`;
}

export function registerMapEntries(server: McpServer): void {
  server.tool(
    'memlab_map_entries',
    'Enumerate the entries of ONE Map or Set (node_id is REQUIRED — this is not a global scan). The companion to memlab_weakmap_entries for strongly-held collections. The KEYS are usually the whole diagnosis of an unbounded cache: a Store/singleton Map keyed by "(filter,timeRange,interval)" or a query hash tells you the cache DIMENSION that is driving growth — which is exactly what you cannot see from a class histogram or retainer trace alone. Shows each key (string keys inlined verbatim), the value class, and value retained size. First locate a Map/Set with memlab_find_nodes_by_class("Map") / ("Set") (or memlab_largest_objects), then pass its node id here.',
    {
      node_id: z
        .number()
        .describe(
          'REQUIRED. The numeric ID of a single Map or Set node. Find candidates with memlab_find_nodes_by_class("Map") or ("Set"); there is no scan-all mode. For WeakMaps use memlab_weakmap_entries.',
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of entries to return (default 20)'),
      sort_by: z
        .enum(['retained_size', 'retained', 'key_name', 'insertion'])
        .optional()
        .default('retained_size')
        .describe(
          'Sort by entry retained size ("retained_size", alias "retained"), key name ("key_name"), or backing-store order ("insertion"). Default: retained_size.',
        ),
    },
    async ({node_id, limit, sort_by}) => {
      try {
        const snapshot = getSnapshot();
        const node = snapshot.getNodeById(node_id);
        if (!node) {
          return errorResult(`Node with id ${node_id} not found`);
        }
        const isMap = node.name === 'Map';
        const isSet = node.name === 'Set';
        if (!isMap && !isSet) {
          return errorResult(
            `@${node_id} is a ${node.name} (${node.type}), not a Map or Set. ` +
              `Use \`memlab_find_nodes_by_class("Map")\` or \`("Set")\` to find ` +
              `instances. For WeakMaps use \`memlab_weakmap_entries\`.`,
          );
        }

        interface MapEntry {
          key: IHeapNode;
          value: IHeapNode | null;
          keyRetained: number;
          valueRetained: number;
        }

        // Enumerate via the shared, index-aware backing-store walk
        // (`src/utils.ts`). It pairs each key with the value in the immediately
        // following FixedArray slot INDEX, so a Map with SMI values (whose value
        // slots emit no edge) reports value:null instead of mispairing the key
        // with the next entry's key. Set elements come back one-per-slot.
        const entries: MapEntry[] = (
          isSet
            ? enumerateSetElements(node).map(k => ({key: k, value: null}))
            : enumerateMapEntries(node)
        ).map(e => ({
          key: e.key,
          value: e.value,
          keyRetained: e.key.retainedSize,
          valueRetained: e.value ? e.value.retainedSize : 0,
        }));

        if (entries.length === 0) {
          return toolResult(
            `${node.name} @${node_id} has no enumerable entries.\n\n` +
              `**Note:** the backing store may hold primitive (SMI/number/bool) ` +
              `values inline rather than as heap objects, or V8's layout may not ` +
              `expose them in this snapshot. Try \`memlab_get_references(${node_id})\` ` +
              `to inspect the raw structure.`,
          );
        }

        if (sort_by === 'retained_size' || sort_by === 'retained') {
          entries.sort(
            (a, b) =>
              b.keyRetained +
              b.valueRetained -
              (a.keyRetained + a.valueRetained),
          );
        } else if (sort_by === 'key_name') {
          entries.sort((a, b) => a.key.name.localeCompare(b.key.name));
        } // 'insertion' keeps backing-store order

        const shown = entries.slice(0, limit);
        const totalEntries = entries.length;
        const totalKeyRetained = entries.reduce((s, e) => s + e.keyRetained, 0);
        const totalValueRetained = entries.reduce(
          (s, e) => s + e.valueRetained,
          0,
        );

        let entryTable: string;
        if (isSet) {
          const headers = ['Value ID', 'Value', 'Retained'];
          const rightCols = new Set([2]);
          const rows = shown.map(e => [
            `@${e.key.id}`,
            describeNode(e.key, 60),
            formatBytes(e.keyRetained),
          ]);
          entryTable = markdownTable(headers, rows, rightCols);
        } else {
          const headers = [
            'Key ID',
            'Key',
            'Value ID',
            'Value',
            'Value Retained',
          ];
          const rightCols = new Set([4]);
          const rows = shown.map(e => [
            `@${e.key.id}`,
            describeNode(e.key, 60),
            e.value ? `@${e.value.id}` : '—',
            e.value ? describeNode(e.value, 40) : '—',
            formatBytes(e.valueRetained),
          ]);
          entryTable = markdownTable(headers, rows, rightCols);
        }

        const lines = [
          `${node.name} @${node_id}: ${formatNumber(totalEntries)} entries` +
            (totalEntries > limit ? ` (showing top ${limit})` : ''),
          isSet
            ? `Total retained: ${formatBytes(totalKeyRetained)}`
            : `Total key retained: ${formatBytes(totalKeyRetained)}, ` +
              `total value retained: ${formatBytes(totalValueRetained)}`,
          '',
          entryTable,
        ];
        if (isMap) {
          lines.push(
            '',
            '_Keys are paired with the value in the immediately-following backing-' +
              'store slot INDEX. Entries whose value is an inline SMI (small int) ' +
              'emit no heap edge, so their value shows as "—" (primitive, not ' +
              'captured) rather than being mispaired with the next entry._',
          );
        }
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
