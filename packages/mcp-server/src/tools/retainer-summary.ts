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
import type {IHeapNode, IHeapEdge} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  filterLargestObjects,
  formatBytes,
  errorResult,
  textResult,
  toolResult,
} from '../utils.js';

interface TraceStep {
  name: string;
  type: string;
  edgeName?: string;
}

function getRetainerTrace(node: IHeapNode): TraceStep[] | null {
  if (!node.hasPathEdge) return null;

  const visited = new Set<number>([node.id]);
  let curNode: IHeapNode | null = node;
  const reverseSteps: TraceStep[] = [{name: curNode.name, type: curNode.type}];

  while (curNode && curNode.hasPathEdge) {
    const edge: IHeapEdge | null = curNode.pathEdge;
    if (!edge) break;
    const fromNode: IHeapNode = edge.fromNode;
    if (visited.has(fromNode.id)) break;
    visited.add(fromNode.id);
    reverseSteps.push({
      name: fromNode.name,
      type: fromNode.type,
      edgeName: String(edge.name_or_index),
    });
    curNode = fromNode;
  }

  reverseSteps.reverse();
  return reverseSteps;
}

function traceToKey(steps: TraceStep[]): string {
  return steps
    .map(s => {
      const edge = s.edgeName != null ? `--${s.edgeName}-->` : '';
      return `${s.name}(${s.type})${edge}`;
    })
    .join(' ');
}

function formatTraceChain(steps: TraceStep[]): string {
  const parts: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    parts.push(`${s.name} (${s.type})`);
    if (s.edgeName != null && i < steps.length - 1) {
      parts.push(` --${s.edgeName}--> `);
    }
  }
  return parts.join('');
}

export function registerRetainerSummary(server: McpServer): void {
  server.tool(
    'memlab_retainer_summary',
    'Trace retainer paths for multiple instances of a class (or a specific set of node IDs) and group by common patterns. Instead of tracing one node at a time, this samples N instances and shows how many share each retainer path pattern. Essential for confirming whether leaked objects share a single root cause. Use node_ids to cluster retainer patterns for specific nodes (e.g., example_node_ids from duplicated_strings).',
    {
      class_name: z
        .string()
        .optional()
        .describe(
          'The constructor/class name to analyze. Required if node_ids is not provided.',
        ),
      node_ids: z
        .array(z.number())
        .optional()
        .describe(
          'Specific node IDs to analyze instead of searching by class name. Use this with example_node_ids from duplicated_strings or other tools.',
        ),
      sample: z
        .number()
        .optional()
        .default(10)
        .describe(
          'Number of instances to sample, picked from the largest by retained size (default 10). Only applies when using class_name.',
        ),
      max_depth: z
        .number()
        .optional()
        .describe(
          'Truncate each retainer trace to this many nodes from the GC root before grouping. Useful for grouping traces that diverge only in the last few hops.',
        ),
    },
    async ({class_name, node_ids, sample, max_depth}) => {
      try {
        const snapshot = getSnapshot();

        let nodes: IHeapNode[];
        let label: string;

        if (node_ids && node_ids.length > 0) {
          nodes = [];
          for (const id of node_ids) {
            const node = snapshot.getNodeById(id);
            if (node) nodes.push(node);
          }
          label = `${nodes.length} specified node(s)`;
        } else if (class_name) {
          nodes = filterLargestObjects(
            snapshot,
            node => node.name === class_name,
            sample,
          );
          label = `"${class_name}"`;
        } else {
          return errorResult(
            new Error('Either class_name or node_ids must be provided.'),
          );
        }

        if (nodes.length === 0) {
          return toolResult(`No objects found for ${label}`);
        }

        const patterns = new Map<
          string,
          {
            steps: TraceStep[];
            count: number;
            example_ids: number[];
            total_retained: number;
          }
        >();
        let noTrace = 0;

        for (const node of nodes) {
          const trace = getRetainerTrace(node);
          if (!trace) {
            noTrace++;
            continue;
          }

          const steps =
            max_depth != null && max_depth > 0 && max_depth < trace.length
              ? trace.slice(0, max_depth)
              : trace;
          const key = traceToKey(steps);

          const existing = patterns.get(key);
          if (existing) {
            existing.count++;
            if (existing.example_ids.length < 3) {
              existing.example_ids.push(node.id);
            }
            existing.total_retained += node.retainedSize;
          } else {
            patterns.set(key, {
              steps,
              count: 1,
              example_ids: [node.id],
              total_retained: node.retainedSize,
            });
          }
        }

        const sorted = [...patterns.values()].sort((a, b) => b.count - a.count);

        const lines = [
          `Retainer summary for ${label} (${nodes.length} sampled${max_depth ? `, depth limited to ${max_depth}` : ''})`,
          '',
        ];

        if (sorted.length === 1) {
          lines.push(
            `**All ${sorted[0].count} sampled instances share the same retainer pattern** — likely a single root cause.`,
            '',
          );
        } else {
          lines.push(
            `**${sorted.length} distinct retainer patterns found:**`,
            '',
          );
        }

        for (let i = 0; i < sorted.length; i++) {
          const p = sorted[i];
          const pct = ((p.count / nodes.length) * 100).toFixed(0);
          lines.push(
            `### Pattern ${i + 1}: ${p.count}/${nodes.length} instances (${pct}%), ${formatBytes(p.total_retained)} retained`,
          );
          lines.push('');
          lines.push(formatTraceChain(p.steps));
          lines.push('');
          lines.push(
            `Example nodes: ${p.example_ids.map(id => `@${id}`).join(', ')}`,
          );
          lines.push('');
        }

        if (noTrace > 0) {
          lines.push(
            `(${noTrace} instance(s) had no retainer path — root or unreachable nodes)`,
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
