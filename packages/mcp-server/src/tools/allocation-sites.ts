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
import {allocationTraces, formatFrame} from '../allocation-traces.js';
import {offsetParam, pageLines, paginate} from '../pagination.js';
import {structuredResult} from '../structured.js';
import {textPattern} from './query-objects.js';
import {errorResult, formatBytes, formatNumber} from '../utils.js';

const NO_TRACES =
  'This snapshot has no allocation stacks. They are recorded only while allocation tracking is on: save a heap timeline ("allocation instrumentation on timeline"), or take the snapshot after `HeapProfiler.startTrackingHeapObjects({trackAllocations: true})`. Both `.heapsnapshot` and `.heaptimeline` files load.';

interface Site {
  traceId: number;
  count: number;
  bytes: number;
  exampleId: number;
}

export function registerAllocationSites(server: McpServer): void {
  server.tool(
    'memlab_allocation_sites',
    'WHO ALLOCATED these objects: group live objects by the JavaScript stack that allocated them, from a capture recorded with allocation tracking (a .heaptimeline, or a snapshot taken while tracking was on). ' +
      'Filter by `class_name` (regex) and `node_type`, or pass one `node_id` for its stack. Sites are ranked by bytes or count and paged; each shows the allocating function, script, line and column, and the frames above it. ' +
      'Pair it with an id-matched `memlab_diff_snapshots` drill-down to see where the objects that survived were allocated. Captures without tracking say so.',
    {
      class_name: z
        .string()
        .optional()
        .describe('Case-insensitive regex on the class or node name.'),
      node_type: z
        .string()
        .optional()
        .describe('Exact node type, e.g. object, closure, array, string.'),
      node_id: z
        .number()
        .optional()
        .describe('Show the allocation stack of this one object.'),
      sort_by: z
        .enum(['bytes', 'count'])
        .optional()
        .default('bytes')
        .describe('Rank sites by self bytes (default) or object count.'),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(10)
        .describe('Sites per page (default 10).'),
      offset: offsetParam(),
      depth: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(8)
        .describe('Frames shown per stack, innermost first (default 8).'),
    },
    async ({class_name, node_type, node_id, sort_by, limit, offset, depth}) => {
      try {
        const snapshot = getSnapshot();
        const traces = allocationTraces(snapshot);
        if (traces == null) {
          return structuredResult(NO_TRACES, {has_allocation_traces: false});
        }
        if (node_id != null) {
          const node = snapshot.getNodeById(node_id);
          if (node == null) return errorResult(`Node @${node_id} not found`);
          const frames = traces.stack(node.trace_node_id, depth);
          return structuredResult(
            frames.length === 0
              ? `@${node_id} has no allocation stack: it was allocated before tracking started, or by the engine.`
              : [
                  `**@${node_id} ${node.name} (${node.type}) was allocated at:**`,
                  '',
                  ...frames.map(
                    (f, i) => `${i === 0 ? '→' : ' '} ${formatFrame(f)}`,
                  ),
                ].join('\n'),
            {has_allocation_traces: true, node_id, stack: frames},
          );
        }

        const nameRe = class_name != null ? textPattern(class_name).re : null;
        const sites = new Map<number, Site>();
        let matched = 0;
        let untraced = 0;
        snapshot.nodes.forEach((node: IHeapNode) => {
          if (node.id <= 3) return;
          if (node_type != null && node.type !== node_type) return;
          if (nameRe != null && !nameRe.test(node.name)) return;
          matched++;
          const tid = node.trace_node_id;
          if (!tid) {
            untraced++;
            return;
          }
          let s = sites.get(tid);
          if (s == null) {
            s = {traceId: tid, count: 0, bytes: 0, exampleId: node.id};
            sites.set(tid, s);
          }
          s.count++;
          s.bytes += node.self_size;
        });
        const ranked = [...sites.values()].sort((a, b) =>
          sort_by === 'count'
            ? b.count - a.count || b.bytes - a.bytes || a.traceId - b.traceId
            : b.bytes - a.bytes || b.count - a.count || a.traceId - b.traceId,
        );
        const page = paginate(ranked, offset, limit);
        const lines = [
          `**${formatNumber(matched)} object(s) match; ${formatNumber(matched - untraced)} have an allocation stack, from ${formatNumber(ranked.length)} distinct stack(s).**` +
            (untraced > 0
              ? ` ${formatNumber(untraced)} were allocated before tracking started or by the engine.`
              : ''),
        ];
        const structuredSites: Array<Record<string, unknown>> = [];
        page.items.forEach((s, i) => {
          const frames = traces.stack(s.traceId, depth);
          structuredSites.push({
            objects: s.count,
            bytes: s.bytes,
            example_id: s.exampleId,
            stack: frames,
          });
          lines.push(
            '',
            `**${page.offset + i + 1}. ${formatNumber(s.count)} object(s), ${formatBytes(s.bytes)}** — e.g. @${s.exampleId}`,
          );
          if (frames.length === 0) {
            lines.push('  (no frames recorded)');
          }
          frames.forEach((f, j) => {
            lines.push(`  ${j === 0 ? '→' : ' '} ${formatFrame(f)}`);
          });
        });
        lines.push('', ...pageLines(page, 'stacks'));
        return structuredResult(lines.join('\n'), {
          has_allocation_traces: true,
          matched,
          untraced,
          sites: structuredSites,
          pagination: {
            offset: page.offset,
            page_size: page.pageSize,
            total: page.total,
            next_offset: page.nextOffset,
          },
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
