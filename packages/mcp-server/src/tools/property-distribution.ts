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

interface ValueStat {
  count: number;
  exampleNodeId: number;
  approxBytes: number;
}

function readPropertyValue(target: IHeapNode): string {
  if (target.isString) {
    const s = target.toStringNode();
    const v = s ? s.stringValue : target.name;
    return v.length > 120 ? v.slice(0, 120) + '…' : v;
  }
  // Inline SMI: value is encoded as id >> 1 with self_size 0.
  if (target.name === 'smi number' && target.self_size === 0) {
    return String(target.id >> 1);
  }
  if (target.name === 'heap number') return '(heap number)';
  if (target.name === 'true' || target.name === 'false') return target.name;
  if (target.name === 'null' || target.name === 'undefined') return target.name;
  // Object/array values: summarize by class, not identity.
  return `<${target.name} (${target.type})>`;
}

export function registerPropertyDistribution(server: McpServer): void {
  server.tool(
    'memlab_property_distribution',
    "For a given object class/shape and property, report the value cardinality plus the top-K most frequent values with their counts. The key tool for diagnosing cardinality explosions (e.g., an OpenTelemetry metric attribute, a cache key, or a per-record field whose unbounded distinct values blow up memory). Complements memlab_shape_histogram (which groups by property *names*) by showing the distribution of a single property's *values*.",
    {
      property: z
        .string()
        .describe('The property name to analyze the value distribution of.'),
      class_name: z
        .string()
        .optional()
        .default('Object')
        .describe(
          'Constructor name of the objects to scan (default "Object"). Use the class shown by class_histogram/shape_histogram.',
        ),
      shape: z
        .array(z.string())
        .optional()
        .describe(
          'Optional exact property-name set to restrict to one shape (as reported by shape_histogram). Only objects whose property names match this set are counted.',
        ),
      top_k: z
        .number()
        .optional()
        .default(15)
        .describe('Number of most-frequent values to show (default 15).'),
      min_count: z
        .number()
        .optional()
        .default(1)
        .describe('Only show values occurring at least this many times.'),
    },
    async ({property, class_name, shape, top_k, min_count}) => {
      try {
        const snapshot = getSnapshot();
        const meta = getSnapshotMetadata();
        const totalSize = meta?.totalSize ?? 0;

        const shapeSet = shape ? new Set(shape) : null;
        const values = new Map<string, ValueStat>();
        let matched = 0;
        let withProp = 0;
        let totalValueBytes = 0;

        snapshot.nodes.forEach(node => {
          if (node.id <= 3 || node.type !== 'object') return;
          if (node.name !== class_name) return;

          // Collect property names + locate the target property in one pass.
          let target: IHeapNode | null = null;
          const propNames: string[] = [];
          for (const edge of node.references) {
            if (edge.type !== 'property') continue;
            const pName = String(edge.name_or_index);
            propNames.push(pName);
            if (pName === property) target = edge.toNode;
          }

          if (shapeSet) {
            if (propNames.length !== shapeSet.size) return;
            for (const p of propNames) if (!shapeSet.has(p)) return;
          }
          matched++;
          if (!target) return;
          withProp++;

          const key = readPropertyValue(target);
          const bytes = target.isString ? target.self_size : 0;
          totalValueBytes += bytes;
          const existing = values.get(key);
          if (existing) {
            existing.count++;
            existing.approxBytes += bytes;
          } else {
            values.set(key, {
              count: 1,
              exampleNodeId: node.id,
              approxBytes: bytes,
            });
          }
        });

        if (matched === 0) {
          return toolResult(
            `No \`${class_name}\` objects${shapeSet ? ' matching that shape' : ''} found. Check the class name with memlab_class_histogram or shape with memlab_shape_histogram.`,
          );
        }

        const cardinality = values.size;
        const sorted = [...values.entries()]
          .filter(([, v]) => v.count >= min_count)
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, top_k);

        const lines: string[] = [
          `## Value distribution of \`${property}\` on \`${class_name}\`${shapeSet ? ' (shape-filtered)' : ''}`,
          '',
          `Objects scanned: ${formatNumber(matched)} | with property: ${formatNumber(withProp)} | distinct values: **${formatNumber(cardinality)}**` +
            (totalValueBytes > 0
              ? ` | string value bytes: ${formatBytes(totalValueBytes)}` +
                (totalSize > 0
                  ? ` (${Math.min(100, (totalValueBytes / totalSize) * 100).toFixed(1)}% of heap)`
                  : '')
              : ''),
          '',
        ];

        // Cardinality interpretation.
        const ratio = withProp > 0 ? cardinality / withProp : 0;
        if (cardinality === 1) {
          lines.push(
            `_Single constant value across all instances — strong candidate for interning or dropping the field._`,
          );
        } else if (ratio > 0.9 && withProp >= 100) {
          lines.push(
            `_Nearly all values are unique (${(ratio * 100).toFixed(0)}% distinct) — a high-cardinality field. If this feeds a metric dimension or cache key, that is likely the cardinality-explosion root cause._`,
          );
        } else if (cardinality <= 20) {
          lines.push(
            `_Low cardinality (${cardinality} values) — can usually be bucketed/filtered at the source or interned._`,
          );
        }
        lines.push('');

        const headers = [
          'Value',
          'Count',
          '% of instances',
          'Str bytes',
          'Example',
        ];
        const rightCols = new Set([1, 2, 3]);
        const rows = sorted.map(([val, v]) => [
          val.length > 60 ? val.slice(0, 57) + '…' : val,
          formatNumber(v.count),
          withProp > 0 ? ((v.count / withProp) * 100).toFixed(1) + '%' : '-',
          v.approxBytes > 0 ? formatBytes(v.approxBytes) : '-',
          `@${v.exampleNodeId}`,
        ]);
        lines.push(markdownTable(headers, rows, rightCols));
        if (cardinality > sorted.length) {
          lines.push('');
          lines.push(
            `… and ${formatNumber(cardinality - sorted.length)} more distinct value(s). Increase top_k to see more.`,
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
