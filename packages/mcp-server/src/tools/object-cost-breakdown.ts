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

interface CostBreakdown {
  instanceCount: number;
  totalSelfSize: number;
  totalRetainedSize: number;
  avgSelfSize: number;
  avgRetainedSize: number;
  heapNumberCount: number;
  smiCount: number;
  stringPropCount: number;
  objectPropCount: number;
  totalHeapNumberSize: number;
  propertyBreakdown: Array<{
    name: string;
    type: string;
    avgSize: number;
    isHeapNumber: boolean;
  }>;
  collectionOverhead: {
    inMapCount: number;
    inSetCount: number;
    inArrayCount: number;
    estimatedCollectionOverhead: number;
  };
}

function analyzePropertyCosts(
  nodes: IHeapNode[],
  sampleSize: number,
): CostBreakdown['propertyBreakdown'] {
  const propStats = new Map<
    string,
    {
      totalSize: number;
      heapNumberCount: number;
      smiCount: number;
      stringCount: number;
      objectCount: number;
      otherCount: number;
      count: number;
    }
  >();

  const sampled = nodes.slice(0, sampleSize);
  for (const node of sampled) {
    for (const edge of node.references) {
      if (edge.type !== 'property') continue;
      const propName = String(edge.name_or_index);
      const target = edge.toNode;
      const existing = propStats.get(propName);
      const isHeapNum =
        target.type === 'number' ||
        (target.type === 'hidden' && target.name === 'system / HeapNumber');
      const isSmi = target.type === 'number' && target.self_size === 0;

      if (existing) {
        existing.totalSize += target.self_size;
        existing.count++;
        if (isSmi) existing.smiCount++;
        else if (isHeapNum) existing.heapNumberCount++;
        else if (target.type === 'string') existing.stringCount++;
        else if (target.type === 'object') existing.objectCount++;
        else existing.otherCount++;
      } else {
        propStats.set(propName, {
          totalSize: target.self_size,
          heapNumberCount: isHeapNum && !isSmi ? 1 : 0,
          smiCount: isSmi ? 1 : 0,
          stringCount: target.type === 'string' ? 1 : 0,
          objectCount: target.type === 'object' ? 1 : 0,
          otherCount:
            !isHeapNum &&
            !isSmi &&
            target.type !== 'string' &&
            target.type !== 'object'
              ? 1
              : 0,
          count: 1,
        });
      }
    }
  }

  const result: CostBreakdown['propertyBreakdown'] = [];
  for (const [name, stats] of propStats) {
    const avgSize = stats.count > 0 ? stats.totalSize / stats.count : 0;
    const dominantType =
      stats.heapNumberCount > stats.count * 0.5
        ? 'heap number'
        : stats.smiCount > stats.count * 0.5
          ? 'smi'
          : stats.stringCount > stats.count * 0.5
            ? 'string'
            : stats.objectCount > stats.count * 0.5
              ? 'object'
              : 'mixed';
    result.push({
      name,
      type: dominantType,
      avgSize,
      isHeapNumber: stats.heapNumberCount > stats.count * 0.5,
    });
  }

  result.sort((a, b) => b.avgSize - a.avgSize);
  return result;
}

export function registerObjectCostBreakdown(server: McpServer): void {
  server.tool(
    'memlab_object_cost_breakdown',
    'Show per-instance V8 memory cost breakdown for a class or shape. Reports: object header overhead, heap number vs SMI property costs, property backing store costs, and collection storage overhead. Compares current cost to theoretical minimum. Use when a cache or array of objects uses more memory than expected — the gap is often V8 overhead, not a code bug.',
    {
      class_name: z
        .string()
        .optional()
        .describe(
          'Constructor/class name to analyze (e.g., "Map", "Object", "MyClass")',
        ),
      node_id: z
        .number()
        .optional()
        .describe(
          'A specific node ID — analyze all instances with the same shape',
        ),
      sample_size: z
        .number()
        .optional()
        .default(100)
        .describe(
          'Number of instances to sample for property analysis (default 100)',
        ),
      show_property_table: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Show the per-property "Property Details" table (default false). Off by default because for generic high-variance classes (Object/Array) it is long and low-signal; turn on when analyzing a single homogeneous shape.',
        ),
    },
    async ({class_name, node_id, sample_size, show_property_table}) => {
      try {
        const snapshot = getSnapshot();
        const meta = getSnapshotMetadata();
        const totalSize = meta?.totalSize ?? 0;

        if (!class_name && !node_id) {
          return toolResult(
            'Provide either `class_name` or `node_id` to analyze.',
          );
        }

        // Collect target instances
        let targetName = class_name ?? '';
        let targetShape: string[] | null = null;
        const instances: IHeapNode[] = [];

        if (node_id) {
          const refNode = snapshot.getNodeById(node_id);
          if (!refNode) {
            return toolResult(`Node @${node_id} not found.`);
          }
          targetName = refNode.name;
          // Get shape of reference node
          const shapeProps: string[] = [];
          for (const edge of refNode.references) {
            if (edge.type === 'property') {
              shapeProps.push(String(edge.name_or_index));
            }
          }
          shapeProps.sort();
          targetShape = shapeProps;

          const shapeKey = shapeProps.join(',');
          snapshot.nodes.forEach(node => {
            if (node.name !== targetName || node.type !== refNode.type) return;
            if (node.id <= 3) return;
            const props: string[] = [];
            for (const edge of node.references) {
              if (edge.type === 'property') {
                props.push(String(edge.name_or_index));
              }
            }
            props.sort();
            if (props.join(',') === shapeKey) {
              instances.push(node);
            }
          });
        } else {
          snapshot.nodes.forEach(node => {
            if (node.id <= 3) return;
            if (node.name === targetName) {
              instances.push(node);
            }
          });
        }

        if (instances.length === 0) {
          return toolResult(
            `No instances found for "${targetName}"${targetShape ? ` with shape {${targetShape.join(', ')}}` : ''}.`,
          );
        }

        // AUTHORITATIVE totals: sum the *measured* self size over EVERY instance
        // (not sample×count). This is the number the headline and "% of heap"
        // are computed from, so the report can never exceed the real footprint
        // (Feedback §1a — the old sample-extrapolation produced 296% of heap).
        let realTotalSelfSize = 0;
        for (const node of instances) {
          realTotalSelfSize += node.self_size;
        }
        const realAvgSelf = realTotalSelfSize / instances.length;

        // Compute aggregate stats
        let totalRetainedSize = 0;
        let heapNumberCount = 0;
        let smiCount = 0;

        // Per-instance own-property counts, to measure shape variance. A high
        // spread here means uniform `count × per-instance-cost` modelling is
        // invalid (Feedback §1a) — different instances have wildly different
        // property counts (e.g. a few giant config objects among small ones).
        const ownPropCounts: number[] = [];

        // Collection membership
        let inMapCount = 0;
        let inSetCount = 0;
        let inArrayCount = 0;

        const sampled = instances.slice(0, sample_size);
        for (const node of sampled) {
          totalRetainedSize += node.retainedSize;

          let ownProps = 0;
          for (const edge of node.references) {
            if (edge.type !== 'property') continue;
            ownProps++;
            const target = edge.toNode;
            const isHeapNum =
              target.type === 'number' ||
              (target.type === 'hidden' &&
                target.name === 'system / HeapNumber');
            const isSmi = target.type === 'number' && target.self_size === 0;

            if (isSmi) {
              smiCount++;
            } else if (isHeapNum) {
              heapNumberCount++;
            }
          }
          ownPropCounts.push(ownProps);

          // Check if stored in collections
          for (const ref of node.referrers) {
            const fromName = ref.fromNode.name;
            if (ref.type === 'element' || ref.type === 'internal') {
              if (fromName === 'Map' || ref.fromNode.type === 'array') {
                const grandparent = ref.fromNode;
                for (const gRef of grandparent.referrers) {
                  if (gRef.fromNode.name === 'Map') {
                    inMapCount++;
                    break;
                  }
                  if (gRef.fromNode.name === 'Set') {
                    inSetCount++;
                    break;
                  }
                }
              }
              if (fromName === 'Array') {
                inArrayCount++;
              }
            }
          }
        }

        const count = sampled.length;
        const avgRetained = totalRetainedSize / count;
        const avgHeapNumbers = heapNumberCount / count;
        const avgSmis = smiCount / count;

        // Shape variance: mean and coefficient-of-variation of per-instance own
        // property counts. avgOwnProps drives the per-instance cost model (NOT
        // the count of *distinct* property names across instances, which for a
        // generic `Object` class can be in the thousands and is what produced
        // the bogus >100%-of-heap total). High CV ⇒ extrapolation is unsafe.
        const avgOwnProps =
          ownPropCounts.reduce((s, c) => s + c, 0) /
          Math.max(1, ownPropCounts.length);
        const maxOwnProps =
          ownPropCounts.length > 0 ? Math.max(...ownPropCounts) : 0;
        const ownPropVariance =
          ownPropCounts.reduce(
            (s, c) => s + (c - avgOwnProps) * (c - avgOwnProps),
            0,
          ) / Math.max(1, ownPropCounts.length);
        const ownPropStdDev = Math.sqrt(ownPropVariance);
        const shapeCV = avgOwnProps > 0 ? ownPropStdDev / avgOwnProps : 0;
        // A generic container class with widely varying property counts.
        const highShapeVariance =
          shapeCV > 0.5 && maxOwnProps - avgOwnProps > 8;

        // Property breakdown
        const propBreakdown = analyzePropertyCosts(instances, sample_size);
        // Distinct property names seen across sampled instances. For a single
        // homogeneous shape this equals the per-instance property count; for a
        // grab-bag `Object` class it can be far larger (the variance signal).
        const numDistinctProps = propBreakdown.length;
        // Per-instance property count used for the cost model — capped so a few
        // huge outliers can't inflate the estimate above the measured size.
        const numProperties = Math.round(avgOwnProps);

        // V8 overhead estimates (based on V8 internals)
        const V8_OBJECT_HEADER = 12; // map pointer + hash + properties
        const V8_PROPERTY_POINTER = 8; // 64-bit pointer per property
        const V8_HEAP_NUMBER = 16; // HeapNumber: map + 8-byte double
        const V8_MAP_ENTRY_OVERHEAD = 48; // key + value + bucket chain
        const V8_SET_ENTRY_OVERHEAD = 32; // key + bucket chain
        const V8_ARRAY_SLOT = 8; // pointer per element

        const objectOverhead = V8_OBJECT_HEADER;
        const propertiesOverhead = numProperties * V8_PROPERTY_POINTER;
        const heapNumOverhead = avgHeapNumbers * V8_HEAP_NUMBER;
        const estimatedPerInstance =
          objectOverhead + propertiesOverhead + heapNumOverhead;

        // Theoretical minimum: using TypedArrays for numeric data. Scale the
        // numeric/non-numeric split (measured over distinct property names) onto
        // the per-instance property count so it can't exceed numProperties and
        // go negative for high-variance classes (Feedback §1a).
        const numericPropsDistinct = propBreakdown.filter(
          p => p.type === 'heap number' || p.type === 'smi',
        ).length;
        const numericFraction =
          numDistinctProps > 0 ? numericPropsDistinct / numDistinctProps : 0;
        const numericProps = Math.min(
          numProperties,
          Math.round(numProperties * numericFraction),
        );
        const nonNumericProps = Math.max(0, numProperties - numericProps);
        const theoreticalMin =
          numericProps * 8 + // Float64 in TypedArray
          nonNumericProps * V8_PROPERTY_POINTER + // pointers for non-numeric
          (nonNumericProps > 0 ? V8_OBJECT_HEADER : 0); // object header if any non-numeric

        // Collection overhead
        const collectionOverhead =
          (inMapCount / count) * V8_MAP_ENTRY_OVERHEAD +
          (inSetCount / count) * V8_SET_ENTRY_OVERHEAD +
          (inArrayCount / count) * V8_ARRAY_SLOT;

        const totalPerInstance = estimatedPerInstance + collectionOverhead;
        // Headline footprint is the MEASURED self size of every instance plus
        // the (estimated, external) collection-entry overhead — never the
        // per-instance model × count, which over-counts on high-variance
        // classes. Collection overhead lives outside the object's own self size,
        // so it is added on top of the measured total (Feedback §1a).
        const collectionTotal = collectionOverhead * instances.length;
        const totalAllInstances = realTotalSelfSize + collectionTotal;
        // Theoretical minimum can't exceed what we actually measured.
        const theoreticalTotal = Math.min(
          theoreticalMin * instances.length,
          realTotalSelfSize,
        );

        const lines: string[] = [
          `# Object Cost Breakdown: \`${targetName}\`${targetShape ? ` {${targetShape.slice(0, 5).join(', ')}${targetShape.length > 5 ? ', …' : ''}}` : ''}`,
          '',
          `**Instances:** ${formatNumber(instances.length)} | **Sampled:** ${formatNumber(count)} | **Measured total self size:** ${formatBytes(realTotalSelfSize)} (avg ${Math.round(realAvgSelf)}B/instance)`,
          '',
        ];

        // Feedback §1a: when an unconstrained class (e.g. `Object`/`Array`) mixes
        // wildly different shapes, a uniform per-instance cost model is invalid.
        // Warn loudly and steer to per-shape tools instead of printing a
        // misleading extrapolated total.
        if (highShapeVariance && !targetShape) {
          lines.push(
            `> ⚠️ **High shape variance** — sampled instances range from ${Math.min(...ownPropCounts)} to ${maxOwnProps} own properties (avg ${avgOwnProps.toFixed(1)}, σ=${ownPropStdDev.toFixed(1)}), and ${formatNumber(numDistinctProps)} distinct property names appear across the class. ` +
              `A single per-instance cost model does **not** apply here — the figures below use the *average* shape and the **measured** ${formatBytes(realTotalSelfSize)} total, not sampled outliers × count. ` +
              `For a meaningful per-shape breakdown, run \`memlab_shape_histogram\` (or re-run this tool with a \`node_id\` to pin one concrete shape).`,
            '',
          );
        }

        lines.push('## Per-Instance Cost (average shape)', '');

        const costHeaders = ['Component', 'Bytes', 'Notes'];
        const costRightCols = new Set([1]);
        const costRows: string[][] = [
          [
            'Object header',
            String(V8_OBJECT_HEADER),
            'Map pointer + hash/properties store',
          ],
          [
            'Property pointers',
            String(propertiesOverhead),
            `${numProperties} properties × ${V8_PROPERTY_POINTER}B`,
          ],
        ];

        if (avgHeapNumbers > 0) {
          costRows.push([
            'Heap numbers',
            String(Math.round(heapNumOverhead)),
            `${avgHeapNumbers.toFixed(1)} heap numbers × ${V8_HEAP_NUMBER}B (values > 2³¹ or non-integer)`,
          ]);
        }
        if (avgSmis > 0) {
          costRows.push([
            'SMI values',
            '0',
            `${avgSmis.toFixed(1)} SMIs — stored inline in pointer (free)`,
          ]);
        }
        if (collectionOverhead > 0) {
          costRows.push([
            'Collection storage',
            String(Math.round(collectionOverhead)),
            [
              inMapCount > 0
                ? `Map: ${((inMapCount / count) * 100).toFixed(0)}%`
                : '',
              inSetCount > 0
                ? `Set: ${((inSetCount / count) * 100).toFixed(0)}%`
                : '',
              inArrayCount > 0
                ? `Array: ${((inArrayCount / count) * 100).toFixed(0)}%`
                : '',
            ]
              .filter(Boolean)
              .join(', '),
          ]);
        }

        costRows.push([
          '**Modeled per instance**',
          `**${Math.round(totalPerInstance)}**`,
          `Measured avg self: ${Math.round(realAvgSelf)}B, retained: ${formatBytes(avgRetained)}`,
        ]);
        costRows.push([
          '_Theoretical min_',
          `_${Math.round(theoreticalMin)}_`,
          numericProps > 0
            ? `${numericProps} numeric props in TypedArray (8B each)`
            : 'Already near minimum',
        ]);

        lines.push(markdownTable(costHeaders, costRows, costRightCols));
        lines.push('');

        // Totals — anchored on the MEASURED self size so the headline can never
        // exceed the real heap footprint (Feedback §1a).
        lines.push('## Total Memory Impact');
        lines.push('');
        lines.push(
          `- **Current (measured self size):** ${formatBytes(realTotalSelfSize)} across ${formatNumber(instances.length)} instances`,
        );
        if (collectionTotal > 0) {
          lines.push(
            `- **+ estimated collection-entry overhead:** ${formatBytes(collectionTotal)} (external Map/Set/Array storage holding these instances) → **${formatBytes(totalAllInstances)}** total`,
          );
        }
        lines.push(
          `- **Theoretical minimum:** ~${formatBytes(theoreticalTotal)} (capped at measured self size)`,
        );
        const overhead = realTotalSelfSize - theoreticalTotal;
        if (overhead > 0 && theoreticalTotal > 0) {
          lines.push(
            `- **V8 overhead vs theoretical:** ~${formatBytes(overhead)} (${((overhead / realTotalSelfSize) * 100).toFixed(0)}% of self size)`,
          );
        }
        if (totalSize > 0) {
          // Clamp defensively; measured self size already can't exceed the heap.
          const pctHeap = Math.min(
            100,
            (realTotalSelfSize / totalSize) * 100,
          ).toFixed(1);
          lines.push(`- **% of heap (self size):** ${pctHeap}%`);
        }
        lines.push('');

        // Property breakdown — gated behind show_property_table because for
        // generic high-variance classes this 20-row table is long and low-signal
        // (Feedback §5).
        if (!show_property_table && propBreakdown.length > 0) {
          lines.push(
            `_${formatNumber(numDistinctProps)} distinct propert${numDistinctProps === 1 ? 'y' : 'ies'} seen across sampled instances. Pass \`show_property_table:true\` for the per-property cost table._`,
            '',
          );
        }
        if (show_property_table && propBreakdown.length > 0) {
          lines.push('## Property Details');
          lines.push('');
          const propHeaders = [
            'Property',
            'Dominant Type',
            'Avg Size',
            'Notes',
          ];
          const propRightCols = new Set([2]);
          const heapNumProps: string[] = [];
          const propRows = propBreakdown.slice(0, 20).map(p => {
            let notes = '';
            if (p.isHeapNumber) {
              heapNumProps.push(p.name);
              notes =
                'Heap number — 16B overhead per value. Consider Int32Array if integer-only.';
            } else if (p.type === 'smi') {
              notes = 'SMI — free (stored inline in pointer)';
            }
            return [p.name, p.type, formatBytes(p.avgSize), notes];
          });
          lines.push(markdownTable(propHeaders, propRows, propRightCols));
          lines.push('');

          if (heapNumProps.length > 0) {
            lines.push(
              `**${heapNumProps.length} heap number properties:** ${heapNumProps.join(', ')}. Each costs 16B vs 0B for SMI. If values are integers ≤ 2³¹, they may be stored as SMI automatically. Non-integer or large values always use HeapNumber.`,
            );
            lines.push('');
          }
        }

        // Optimization suggestions
        lines.push('## Optimization Options');
        lines.push('');
        if (numericProps >= 3) {
          lines.push(
            `1. **TypedArray columnar storage:** Move ${numericProps} numeric properties into a \`Float64Array\`. Saves ${formatBytes((V8_HEAP_NUMBER - 8) * numericProps * instances.length)} from heap number elimination.`,
          );
        }
        if (avgHeapNumbers > 0) {
          lines.push(
            `${numericProps >= 3 ? '2' : '1'}. **Reduce heap numbers:** Values stored as HeapNumber (16B each) instead of SMI (0B). Check if values can be kept as integers ≤ 2³¹.`,
          );
        }
        if (instances.length > 10000) {
          lines.push(
            `- **Columnar layout:** For ${formatNumber(instances.length)} instances, consider struct-of-arrays instead of array-of-structs to eliminate per-object overhead.`,
          );
        }
        if (collectionOverhead > V8_OBJECT_HEADER) {
          lines.push(
            `- **Collection choice:** Current collection overhead is ${Math.round(collectionOverhead)}B/instance. Array storage (${V8_ARRAY_SLOT}B/slot) is cheaper than Map (${V8_MAP_ENTRY_OVERHEAD}B/entry).`,
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
