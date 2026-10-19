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
import {structuredResult} from '../structured.js';
import {getSnapshot, getSnapshotByHandle} from '../heap-state.js';
import {
  RETAINED_BY,
  RETAINED_BY_LABEL,
  retainedOnlyBy,
  type RetainedBy,
} from '../retention-filters.js';
import {
  clampLabel,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
} from '../utils.js';

interface ClassRow {
  type: string;
  name: string;
  count: number;
  size: number;
}

export function registerRetainedBy(server: McpServer): void {
  server.tool(
    'memlab_retained_by',
    'How much of the heap is retained ONLY through each kind of retainer: closure contexts, detached DOM nodes, the DevTools console, and event handler functions. ' +
      'An object counts when the roots reach it, but no longer do once the walk refuses to step into that kind of retainer, so removing every such retainer would free it. Reports objects, self bytes and share of the heap per kind, with the largest classes. ' +
      'Kinds can overlap (an object can depend on a context AND a handler), so rows are not added up. To list or histogram the objects of one kind, pass `retained_by` to `memlab_query_objects` or `memlab_class_histogram`.',
    {
      handle: z
        .string()
        .optional()
        .describe('Snapshot to analyze (defaults to the active one).'),
      kind: z
        .enum(RETAINED_BY)
        .optional()
        .describe('Report only this kind (default: all four).'),
      top_classes: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(5)
        .describe('Largest classes listed per kind (default 5; 0 for none).'),
    },
    async ({handle, kind, top_classes}) => {
      try {
        const snapshot =
          handle != null ? getSnapshotByHandle(handle) : getSnapshot();
        if (snapshot == null) {
          return errorResult(
            new Error(`Snapshot "${handle}" is not resident.`),
          );
        }
        let heapSelf = 0;
        snapshot.nodes.forEach((node: IHeapNode) => {
          heapSelf += node.self_size;
        });
        const kinds: readonly RetainedBy[] =
          kind != null ? [kind] : RETAINED_BY;
        const summary: string[][] = [];
        const kindsData: Array<Record<string, unknown>> = [];
        const details: string[] = [];
        for (const k of kinds) {
          const started = Date.now();
          const mask = retainedOnlyBy(snapshot, k);
          let count = 0;
          let size = 0;
          const byClass = new Map<string, ClassRow>();
          snapshot.nodes.forEach((node: IHeapNode) => {
            if (!mask[node.nodeIndex]) return;
            count++;
            size += node.self_size;
            if (top_classes === 0) return;
            const key = `${node.type}::${node.name}`;
            let row = byClass.get(key);
            if (row == null) {
              row = {type: node.type, name: node.name, count: 0, size: 0};
              byClass.set(key, row);
            }
            row.count++;
            row.size += node.self_size;
          });
          kindsData.push({
            kind: k,
            objects: count,
            self_size: size,
            share_of_heap: heapSelf > 0 ? size / heapSelf : null,
          });
          summary.push([
            RETAINED_BY_LABEL[k],
            `\`${k}\``,
            formatNumber(count),
            formatBytes(size),
            heapSelf > 0 ? `${((100 * size) / heapSelf).toFixed(1)}%` : '—',
            `${((Date.now() - started) / 1000).toFixed(1)} s`,
          ]);
          if (top_classes > 0 && count > 0) {
            const top = [...byClass.values()]
              .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))
              .slice(0, top_classes);
            details.push(
              '',
              `**Retained only through ${RETAINED_BY_LABEL[k]}** — largest classes:`,
              '',
              markdownTable(
                ['Class', 'Type', 'Count', 'Self'],
                top.map(r => [
                  clampLabel(r.name, 80),
                  r.type,
                  formatNumber(r.count),
                  formatBytes(r.size),
                ]),
                new Set([2, 3]),
              ),
            );
          }
        }
        const lines = [
          `**Retained only through …** (of ${formatBytes(heapSelf)} self size in the heap)`,
          '',
          markdownTable(
            [
              'Retainer',
              '`retained_by`',
              'Objects',
              'Self',
              '% of heap',
              'Time',
            ],
            summary,
            new Set([2, 3, 4, 5]),
          ),
          '',
          '_Kinds can overlap, so the rows are not added up._',
          ...(kinds.includes('contexts')
            ? [
                '_Module-level variables live in closure contexts too, so `contexts` covers most module state; narrow it with `class_name` or `native_context` on `memlab_query_objects`._',
              ]
            : []),
          ...details,
        ];
        return structuredResult(
          lines.join('\n'),
          {heap_self_size: heapSelf, kinds: kindsData},
          {snapshot: handle},
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
