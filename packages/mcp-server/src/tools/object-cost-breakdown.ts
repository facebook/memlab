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
import {
  readRawElements,
  describeElements,
  getSlotBytes,
  FORGIVEN_TAIL_SLOTS,
} from '../heap-shapes.js';
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
    'Show per-instance V8 memory cost breakdown for a class or shape. Reports: object header overhead, heap number vs SMI property costs, property backing store costs, and collection storage overhead. Compares the measured cost with the cost after moving numeric properties into typed-array columns; sizes follow the field width of the capture (4-byte compressed or 8-byte). Use when a cache or array of objects uses more memory than expected — the gap is often V8 overhead, not a code bug.',
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
        let heapNumberBytes = 0;
        // A HeapNumber can be shared by several instances; its bytes count once.
        const seenHeapNumbers = new Set<number>();
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

        // Elements backing stores. An integer-keyed object's bytes live on a
        // `(object elements)` FixedArray that belongs to no class, so they are
        // invisible to self_size, to a class histogram, and — until now — to
        // this breakdown. On one capture that was 31.3 MB for a single class,
        // 23.0 MB of it unused capacity.
        const slotBytes = getSlotBytes(snapshot);
        let elementsInstances = 0;
        let elementsBytes = 0;
        let elementsCapacity = 0;
        let elementsUsed = 0;
        let elementsWasteSlots = 0;
        let elementsUnmeasurable = 0;
        let elementsDictionary = 0;

        const sampled = instances.slice(0, sample_size);
        for (const node of sampled) {
          totalRetainedSize += node.retainedSize;

          const raw = readRawElements(node);
          const els = raw ? describeElements(raw, slotBytes) : null;
          if (els) {
            elementsInstances++;
            elementsBytes += els.storeBytes;
            if (els.mode === 'dictionary') {
              elementsDictionary++;
            } else if (!els.measurable) {
              // All holes or all small integers — a snapshot cannot tell those
              // apart, so counting it either way would be a guess.
              elementsUnmeasurable++;
            } else {
              elementsCapacity += els.capacity;
              elementsUsed += els.used;
              elementsWasteSlots +=
                els.holes + Math.max(0, els.slack - FORGIVEN_TAIL_SLOTS);
            }
          }

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
              if (!seenHeapNumbers.has(target.id)) {
                seenHeapNumbers.add(target.id);
                heapNumberBytes += target.self_size;
              }
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

        // Sizes in V8 tagged fields: 4 bytes with pointer compression (Chrome),
        // 8 without (Node.js by default). A JS object is a 3-field header (map,
        // properties, elements) plus its in-object fields. The field count is
        // read off the MEASURED self size rather than the visible edges: a
        // field holding a small integer has no edge in the snapshot.
        const headerBytes = 3 * slotBytes;
        const fieldBytes = Math.max(0, realAvgSelf - headerBytes);
        const fieldCount = Math.round(fieldBytes / slotBytes);
        const hiddenFields = Math.max(0, fieldCount - numProperties);
        // Owned OUTSIDE the object: heap numbers are objects of their own, and
        // a collection entry lives in the collection's backing store.
        const heapNumPerInstance = heapNumberBytes / count;
        const MAP_ENTRY_FIELDS = 3; // key, value, chain
        const SET_ENTRY_FIELDS = 2; // key, chain
        const collectionOverhead =
          ((inMapCount / count) * MAP_ENTRY_FIELDS +
            (inSetCount / count) * SET_ENTRY_FIELDS +
            inArrayCount / count) *
          slotBytes;

        // Moving the numeric properties into Float64Array columns removes
        // their in-object fields and the heap numbers they point at, and adds
        // 8 bytes per value. Both the "after" total and the suggestion below
        // come from this one number, so they cannot disagree.
        const numericPropsDistinct = propBreakdown.filter(
          p => p.type === 'heap number' || p.type === 'smi',
        ).length;
        const numericFraction =
          numDistinctProps > 0 ? numericPropsDistinct / numDistinctProps : 0;
        const numericProps = Math.min(
          numProperties,
          Math.round(numProperties * numericFraction),
        );
        const columnarSavingPerInstance =
          numericProps * slotBytes + heapNumPerInstance - numericProps * 8;
        const columnarSaving =
          Math.max(0, columnarSavingPerInstance) * instances.length;

        // Headline footprint is MEASURED: every instance's self size plus the
        // heap numbers it owns. The collection-entry estimate is reported on
        // top, separately.
        const heapNumberTotal = heapNumPerInstance * instances.length;
        const currentTotal = realTotalSelfSize + heapNumberTotal;
        const collectionTotal = collectionOverhead * instances.length;

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
            String(headerBytes),
            `map, properties, elements: 3 × ${slotBytes}B fields`,
          ],
          [
            'In-object fields',
            String(Math.round(fieldBytes)),
            `≈${fieldCount} × ${slotBytes}B; ${numProperties} with a visible property edge` +
              (hiddenFields > 0
                ? `, the other ${hiddenFields} hold small integers or unused slack (no edge in a snapshot)`
                : '') +
              (avgSmis > 0
                ? `; ${avgSmis.toFixed(1)} small integers stored inline (no extra cost)`
                : ''),
          ],
          [
            '**Self size (measured)**',
            `**${Math.round(realAvgSelf)}**`,
            `retained ${formatBytes(avgRetained)}`,
          ],
        ];

        if (avgHeapNumbers > 0) {
          costRows.push([
            'Heap numbers (outside)',
            String(Math.round(heapNumPerInstance)),
            `${avgHeapNumbers.toFixed(1)} per instance, ${Math.round(heapNumberBytes / Math.max(1, seenHeapNumbers.size))}B each (non-integer or > 2³¹ values)`,
          ]);
        }
        if (collectionOverhead > 0) {
          costRows.push([
            'Collection entry (outside, estimate)',
            String(Math.round(collectionOverhead)),
            [
              inMapCount > 0
                ? `Map: ${((inMapCount / count) * 100).toFixed(0)}% × ${MAP_ENTRY_FIELDS} fields`
                : '',
              inSetCount > 0
                ? `Set: ${((inSetCount / count) * 100).toFixed(0)}% × ${SET_ENTRY_FIELDS} fields`
                : '',
              inArrayCount > 0
                ? `Array: ${((inArrayCount / count) * 100).toFixed(0)}% × 1 field`
                : '',
            ]
              .filter(Boolean)
              .join(', '),
          ]);
        }

        if (elementsInstances > 0) {
          const perInstanceElements = elementsBytes / count;
          const wasteBytes = elementsWasteSlots * slotBytes;
          const occupancy =
            elementsCapacity > 0
              ? `${Math.round((elementsUsed / elementsCapacity) * 100)}% full`
              : 'occupancy not readable';
          costRows.push([
            'Elements store (outside)',
            String(Math.round(perInstanceElements)),
            `${elementsInstances}/${count} sampled instance(s) carry one — ${occupancy}` +
              (wasteBytes > 0
                ? `, ${formatBytes(wasteBytes / count)}/instance of it unused`
                : '') +
              (elementsUnmeasurable > 0
                ? `; ${elementsUnmeasurable} unmeasurable (all-SMI or all-hole)`
                : '') +
              (elementsDictionary > 0
                ? `; ${elementsDictionary} dictionary-mode`
                : ''),
          ]);
        }

        lines.push(markdownTable(costHeaders, costRows, costRightCols));
        lines.push('');

        lines.push('## Total Memory Impact');
        lines.push('');
        lines.push(
          `- **Current (measured):** ${formatBytes(currentTotal)} across ${formatNumber(instances.length)} instances` +
            (heapNumberTotal > 0
              ? ` — ${formatBytes(realTotalSelfSize)} self size + ${formatBytes(heapNumberTotal)} heap numbers they own`
              : ' of self size'),
        );
        if (collectionTotal > 0) {
          lines.push(
            `- **+ estimated collection entries:** ${formatBytes(collectionTotal)} in the Map/Set/Array storage holding these instances`,
          );
        }
        if (numericProps > 0) {
          lines.push(
            columnarSaving > 0
              ? `- **With the ${numericProps} numeric properties in Float64Array columns:** ~${formatBytes(currentTotal - columnarSaving)} (saves ~${formatBytes(columnarSaving)})`
              : `- **Numeric properties are already cheap:** moving them into Float64Array columns would not save memory (${slotBytes}B inline fields, ${avgHeapNumbers > 0 ? 'few' : 'no'} heap numbers).`,
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
        if (numericProps >= 3 && columnarSaving > 0) {
          lines.push(
            `1. **TypedArray columnar storage:** Move ${numericProps} numeric properties into a \`Float64Array\`. Saves ~${formatBytes(columnarSaving)} (their ${slotBytes}B fields and heap numbers, minus 8B per stored value).`,
          );
        }
        if (avgHeapNumbers > 0) {
          lines.push(
            `${numericProps >= 3 && columnarSaving > 0 ? '2' : '1'}. **Reduce heap numbers:** ${formatBytes(heapNumberTotal)} goes to heap numbers. Values that stay integers within ±2³⁰ are stored inline at no extra cost.`,
          );
        }
        if (instances.length > 10000) {
          lines.push(
            `- **Columnar layout:** For ${formatNumber(instances.length)} instances, consider struct-of-arrays instead of array-of-structs to eliminate per-object overhead.`,
          );
        }
        if (
          elementsCapacity > 0 &&
          elementsUsed / elementsCapacity < 0.5 &&
          elementsWasteSlots * slotBytes > 1024
        ) {
          lines.push(
            `- **Sparse elements:** the elements stores are only ` +
              `${Math.round((elementsUsed / elementsCapacity) * 100)}% full, wasting ` +
              `${formatBytes(elementsWasteSlots * slotBytes)} across the sampled instances. ` +
              `Run \`memlab_sparse_elements\` for the per-owner breakdown and whether the ` +
              `cause is sparse keys or over-allocation — they need different fixes.`,
          );
        }
        if (collectionOverhead > headerBytes) {
          lines.push(
            `- **Collection choice:** Current collection overhead is ${Math.round(collectionOverhead)}B/instance. Array storage (${slotBytes}B/slot) is cheaper than Map (${MAP_ENTRY_FIELDS * slotBytes}B/entry).`,
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
