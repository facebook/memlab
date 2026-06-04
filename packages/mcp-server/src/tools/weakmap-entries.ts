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
} from '../utils.js';

export function registerWeakMapEntries(server: McpServer): void {
  server.tool(
    'memlab_weakmap_entries',
    'Enumerate the key-value pairs of ONE WeakMap (node_id is REQUIRED — this is not a global scan). WeakMaps back DataStore, private fields, and metadata caches; since keys are weakly held, their entries reveal which objects are associated and what metadata is stored. First locate a WeakMap with memlab_find_nodes_by_class("WeakMap") (or memlab_largest_objects), then pass its node id here.',
    {
      node_id: z
        .number()
        .describe(
          'REQUIRED. The numeric ID of a single WeakMap node. Find candidates with memlab_find_nodes_by_class("WeakMap"); there is no scan-all-WeakMaps mode.',
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of entries to return (default 20)'),
      sort_by: z
        .enum(['retained_size', 'retained', 'key_name'])
        .optional()
        .default('retained_size')
        .describe(
          'Sort entries by key retained size ("retained_size", alias "retained") or key name ("key_name"). Default: retained_size.',
        ),
    },
    async ({node_id, limit, sort_by}) => {
      try {
        const snapshot = getSnapshot();
        const node = snapshot.getNodeById(node_id);
        if (!node) {
          return errorResult(`Node with id ${node_id} not found`);
        }
        if (node.name !== 'WeakMap') {
          return errorResult(
            `@${node_id} is a ${node.name} (${node.type}), not a WeakMap. ` +
              `Use \`memlab_find_nodes_by_class("WeakMap")\` to find WeakMap instances.`,
          );
        }

        // V8 stores WeakMap entries in a backing table (EphemeronHashTable)
        // accessible via the "table" internal edge. Entries are stored as
        // alternating key-value pairs in the table array.
        interface WMEntry {
          key: IHeapNode;
          value: IHeapNode;
          keyRetained: number;
          valueRetained: number;
        }

        const entries: WMEntry[] = [];

        for (const edge of node.references) {
          const eName = String(edge.name_or_index);
          if (eName !== 'table' && eName !== 'backing_store') continue;

          const table = edge.toNode;
          const tableRefs: IHeapNode[] = [];
          for (const te of table.references) {
            if (te.type === 'internal' || te.type === 'hidden') continue;
            tableRefs.push(te.toNode);
          }

          // WeakMap tables store key-value pairs: [key1, val1, key2, val2, ...]
          for (let i = 0; i < tableRefs.length - 1; i += 2) {
            const key = tableRefs[i];
            const value = tableRefs[i + 1];
            if (key.id <= 3) continue;
            if (key.name === 'undefined' || key.name === 'the_hole') continue;
            entries.push({
              key,
              value,
              keyRetained: key.retainedSize,
              valueRetained: value.retainedSize,
            });
          }
          break;
        }

        // Fallback: try to read entries from ephemeron edges (some V8 versions)
        if (entries.length === 0) {
          for (const edge of node.references) {
            if (
              edge.type !== 'weak' &&
              edge.type !== 'property' &&
              edge.type !== 'element'
            )
              continue;
            const target = edge.toNode;
            if (target.id <= 3) continue;
            if (target.name === 'undefined' || target.name === 'the_hole')
              continue;
            // Each weak edge points to a key; the corresponding value
            // is the next non-weak edge or accessible through the key's references
            entries.push({
              key: target,
              value: target,
              keyRetained: target.retainedSize,
              valueRetained: 0,
            });
          }
        }

        if (entries.length === 0) {
          return toolResult(
            `WeakMap @${node_id} has no enumerable entries.\n\n` +
              `**Note:** V8's WeakMap implementation uses an EphemeronHashTable ` +
              `whose entries may not be fully exposed in the heap snapshot. ` +
              `Try \`memlab_get_references(${node_id})\` to inspect the raw structure.`,
          );
        }

        if (sort_by === 'retained_size' || sort_by === 'retained') {
          entries.sort(
            (a, b) =>
              b.keyRetained +
              b.valueRetained -
              (a.keyRetained + a.valueRetained),
          );
        } else {
          entries.sort((a, b) => a.key.name.localeCompare(b.key.name));
        }

        const shown = entries.slice(0, limit);
        const totalEntries = entries.length;
        const totalKeyRetained = entries.reduce((s, e) => s + e.keyRetained, 0);
        const totalValueRetained = entries.reduce(
          (s, e) => s + e.valueRetained,
          0,
        );

        const headers = [
          'Key ID',
          'Key',
          'Key Retained',
          'Value ID',
          'Value',
          'Value Retained',
        ];
        const rightCols = new Set([2, 5]);
        const rows = shown.map(e => {
          const keyName = truncateNodeName(
            e.key.name,
            e.key.type,
            e.key.self_size,
            40,
          );
          let valueName: string;
          if (e.value === e.key) {
            valueName = '(see key)';
          } else {
            valueName = truncateNodeName(
              e.value.name,
              e.value.type,
              e.value.self_size,
              40,
            );
            if (e.value.isString) {
              const strNode = e.value.toStringNode();
              if (strNode) {
                const val = strNode.stringValue;
                valueName = `"${val.length > 35 ? val.slice(0, 35) + '...' : val}"`;
              }
            }
          }
          return [
            `@${e.key.id}`,
            `${keyName} (${e.key.type})`,
            formatBytes(e.keyRetained),
            `@${e.value.id}`,
            `${valueName} (${e.value.type})`,
            formatBytes(e.valueRetained),
          ];
        });

        const lines = [
          `WeakMap @${node_id}: ${formatNumber(totalEntries)} entries` +
            (totalEntries > limit ? ` (showing top ${limit})` : ''),
          `Total key retained: ${formatBytes(totalKeyRetained)}, total value retained: ${formatBytes(totalValueRetained)}`,
          '',
          markdownTable(headers, rows, rightCols),
        ];

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
