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
import {getSnapshot, getSnapshotMetadata} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';

interface InternGroup {
  propertyName: string;
  parentShape: string;
  parentShapeProps: string[];
  uniqueStrings: number;
  totalCopies: number;
  totalSize: number;
  savingsIfInterned: number;
  topStrings: Array<{value: string; count: number; size: number}>;
  exampleParentId: number;
}

export function registerInternOpportunities(server: McpServer): void {
  server.tool(
    'memlab_intern_opportunities',
    'Identify string interning opportunities by grouping duplicated strings by the property name and parent object shape that holds them. Shows total savings per (property × shape) combination — the key metric for deciding where to add a string interning pool. Replaces the manual workflow of: duplicated_strings → retainer_summary → codebase grep.',
    {
      limit: z
        .number()
        .optional()
        .default(15)
        .describe('Maximum number of intern groups to return (default 15)'),
      min_copies: z
        .number()
        .optional()
        .default(100)
        .describe(
          'Minimum total copies across all strings in a group (default 100)',
        ),
      min_savings: z
        .number()
        .optional()
        .default(102400)
        .describe(
          'Minimum savings in bytes to include a group (default 100 KB)',
        ),
    },
    async ({limit, min_copies, min_savings}) => {
      try {
        const snapshot = getSnapshot();
        const meta = getSnapshotMetadata();
        const totalSize = meta?.totalSize ?? 0;

        // Step 1: Build frequency map of duplicated strings
        const stringMap = new Map<
          string,
          {count: number; totalSize: number; exampleIds: number[]}
        >();

        snapshot.nodes.forEach(node => {
          if (node.type !== 'string') return;
          if (node.name === 'system / SlicedString') return;
          const strNode = node.toStringNode();
          if (!strNode) return;
          const value = strNode.stringValue;
          const entry = stringMap.get(value);
          if (entry) {
            entry.count++;
            entry.totalSize += node.retainedSize;
            if (entry.exampleIds.length < 20) {
              entry.exampleIds.push(node.id);
            }
          } else {
            stringMap.set(value, {
              count: 1,
              totalSize: node.retainedSize,
              exampleIds: [node.id],
            });
          }
        });

        // Step 2: For duplicated strings, sample referrers to get property × shape
        const groupMap = new Map<
          string,
          {
            propertyName: string;
            parentShapeProps: string[];
            parentShapeKey: string;
            strings: Map<string, {count: number; size: number}>;
            totalCopies: number;
            totalSize: number;
            exampleParentId: number;
          }
        >();

        for (const [value, stats] of stringMap) {
          if (stats.count < 2) continue;

          // Sample referrers to determine which (property, shape) groups hold this string
          const groupDist = new Map<
            string,
            {
              sampledCount: number;
              propName: string;
              parentProps: string[];
              shapeKey: string;
              parentId: number;
              sampleRetained: number;
            }
          >();
          let samplesProcessed = 0;

          for (const nodeId of stats.exampleIds) {
            const node = snapshot.getNodeById(nodeId);
            if (!node) continue;

            for (const ref of node.referrers) {
              if (ref.type !== 'property' && ref.type !== 'context') continue;
              const propName = String(ref.name_or_index);
              const parent = ref.fromNode;

              const parentProps: string[] = [];
              for (const edge of parent.references) {
                if (edge.type === 'property') {
                  parentProps.push(String(edge.name_or_index));
                  if (parentProps.length >= 12) break;
                }
              }
              parentProps.sort();
              const shapeKey =
                parent.name !== 'Object'
                  ? parent.name
                  : parentProps.length > 0
                    ? `{${parentProps.join(',')}}`
                    : 'Object';

              const groupKey = `${propName}::${shapeKey}`;
              const dist = groupDist.get(groupKey);
              if (dist) {
                dist.sampledCount++;
                dist.sampleRetained += node.retainedSize;
              } else {
                groupDist.set(groupKey, {
                  sampledCount: 1,
                  propName,
                  parentProps,
                  shapeKey,
                  parentId: parent.id,
                  sampleRetained: node.retainedSize,
                });
              }
              samplesProcessed++;
              break;
            }
          }

          if (samplesProcessed === 0) continue;

          // Extrapolate true counts from sample using stats.count
          for (const [groupKey, dist] of groupDist) {
            const scaleFactor = stats.count / samplesProcessed;
            const trueCount = Math.round(dist.sampledCount * scaleFactor);
            const trueSize =
              stats.totalSize * (dist.sampledCount / samplesProcessed);

            const existing = groupMap.get(groupKey);
            if (existing) {
              const strEntry = existing.strings.get(value);
              if (strEntry) {
                strEntry.count += trueCount;
                strEntry.size += trueSize;
              } else {
                existing.strings.set(value, {
                  count: trueCount,
                  size: trueSize,
                });
              }
              existing.totalCopies += trueCount;
              existing.totalSize += trueSize;
            } else {
              groupMap.set(groupKey, {
                propertyName: dist.propName,
                parentShapeProps: dist.parentProps,
                parentShapeKey: dist.shapeKey,
                strings: new Map([[value, {count: trueCount, size: trueSize}]]),
                totalCopies: trueCount,
                totalSize: trueSize,
                exampleParentId: dist.parentId,
              });
            }
          }
        }

        // Step 3: Compute savings and filter
        const groups: InternGroup[] = [];
        for (const g of groupMap.values()) {
          if (g.totalCopies < min_copies) continue;

          let savingsIfInterned = 0;
          const topStrings: Array<{
            value: string;
            count: number;
            size: number;
          }> = [];

          for (const [value, strStats] of g.strings) {
            if (strStats.count > 1) {
              const perCopy = strStats.size / strStats.count;
              savingsIfInterned += (strStats.count - 1) * perCopy;
            }
            topStrings.push({
              value,
              count: strStats.count,
              size: strStats.size,
            });
          }

          if (savingsIfInterned < min_savings) continue;

          topStrings.sort((a, b) => b.size - a.size);

          groups.push({
            propertyName: g.propertyName,
            parentShape: g.parentShapeKey,
            parentShapeProps: g.parentShapeProps,
            uniqueStrings: g.strings.size,
            totalCopies: g.totalCopies,
            totalSize: g.totalSize,
            savingsIfInterned,
            topStrings: topStrings.slice(0, 3),
            exampleParentId: g.exampleParentId,
          });
        }

        groups.sort((a, b) => b.savingsIfInterned - a.savingsIfInterned);
        const shown = groups.slice(0, limit);

        if (shown.length === 0) {
          return toolResult(
            `No significant interning opportunities found (min ${formatNumber(min_copies)} copies, min ${formatBytes(min_savings)} savings). Try lowering thresholds.`,
          );
        }

        const totalSavings = shown.reduce(
          (sum, g) => sum + g.savingsIfInterned,
          0,
        );
        const pctOfHeap =
          totalSize > 0
            ? ` (${((totalSavings / totalSize) * 100).toFixed(1)}% of heap)`
            : '';

        const headers = [
          'Property',
          'Parent Shape',
          'Unique Strings',
          'Total Copies',
          'Total Size',
          'Savings',
          '% Heap',
          'Example Parent',
        ];
        const rightCols = new Set([2, 3, 4, 5, 6]);
        const rows = shown.map(g => {
          const shape =
            g.parentShape.length > 40
              ? g.parentShape.slice(0, 37) + '…}'
              : g.parentShape;
          const pct =
            totalSize > 0
              ? ((g.savingsIfInterned / totalSize) * 100).toFixed(1) + '%'
              : '-';
          return [
            `.${g.propertyName}`,
            shape,
            formatNumber(g.uniqueStrings),
            formatNumber(g.totalCopies),
            formatBytes(g.totalSize),
            formatBytes(g.savingsIfInterned),
            pct,
            `@${g.exampleParentId}`,
          ];
        });

        const lines = [
          `# String Interning Opportunities`,
          '',
          `**Total savings if top ${shown.length} groups are interned: ${formatBytes(totalSavings)}${pctOfHeap}**`,
          '',
          markdownTable(headers, rows, rightCols),
          '',
        ];

        // Show top strings for the top 5 groups
        for (const g of shown.slice(0, 5)) {
          lines.push(
            `### \`.${g.propertyName}\` on \`${g.parentShape.length > 60 ? g.parentShape.slice(0, 57) + '…}' : g.parentShape}\` — ${formatBytes(g.savingsIfInterned)} savings`,
          );
          for (const s of g.topStrings) {
            const val =
              s.value.length > 60 ? s.value.slice(0, 60) + '…' : s.value;
            lines.push(
              `- "${val}" × ${formatNumber(s.count)} copies (${formatBytes(s.size)})`,
            );
          }
          lines.push('');
        }

        // Detect partial interning patterns (Feedback #3):
        // If strings in a group have a consistent low duplication factor (e.g., all ~4 copies),
        // it suggests multiple independent intern pools instead of one shared pool.
        const partialInternAlerts: string[] = [];
        for (const g of shown) {
          if (g.uniqueStrings < 10) continue;
          const counts = g.topStrings.map(s => s.count);
          if (counts.length < 2) continue;

          const median = counts.sort((a, b) => a - b)[
            Math.floor(counts.length / 2)
          ];
          if (median < 2 || median > 20) continue;

          const consistent = counts.every(
            c => c >= median * 0.5 && c <= median * 2,
          );
          if (!consistent) continue;

          const perPoolSavings = g.savingsIfInterned;
          partialInternAlerts.push(
            `⚠️ **\`.${g.propertyName}\` on \`${g.parentShape.length > 50 ? g.parentShape.slice(0, 47) + '…}' : g.parentShape}\`:** ` +
              `${formatNumber(g.uniqueStrings)} unique strings each duplicated ~${median}× — ` +
              `suggests **${median} independent intern pools** instead of one shared pool. ` +
              `Consolidating into a single shared pool would save ~${formatBytes(perPoolSavings)}.`,
          );
        }

        if (partialInternAlerts.length > 0) {
          lines.push(
            '## Partial Interning Detected',
            '',
            'Strings that are partially deduplicated — interned within each dataset/call but duplicated across them:',
            '',
            ...partialInternAlerts,
            '',
            '_This typically happens when `internStrings()` or a dedup function creates a new Map per call instead of sharing one across datasets. Fix: lift the intern pool to module scope or pass it as a parameter._',
            '',
          );
        }

        lines.push(
          '---',
          '',
          '**How to fix:** Add a string interning pool at the JSON.parse / API response boundary:',
          '```js',
          'const internPool = new Map();',
          'function intern(s) { let v = internPool.get(s); if (!v) { internPool.set(s, s); v = s; } return v; }',
          '// Apply to the property during ingestion:',
          '// obj.propertyName = intern(obj.propertyName);',
          '```',
          '',
          '**Next steps:**',
          `- Inspect example parent: \`memlab_object_shape(${shown[0].exampleParentId})\``,
          `- Find all instances: \`memlab_find_by_shape\` with properties ${JSON.stringify(shown[0].parentShapeProps.slice(0, 5))}`,
          '- Search codebase for the constructor/factory that creates these objects',
        );

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
