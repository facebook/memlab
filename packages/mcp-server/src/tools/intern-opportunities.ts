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
  // True when the group shows the partial-interning signature (each string
  // duplicated a consistent ~N×) — its savings are CROSS-load and cannot be
  // captured by a per-load/per-request intern pool (Feedback round 3 §1c).
  crossLoad?: boolean;
  // True when the duplicated instances are ALSO retained by another structure
  // (e.g. a raw array / matrix). Interning at this property reclaims ~nothing —
  // the other referrer keeps every per-row instance alive — so the shared
  // source must be deduped or dropped instead (Feedback round 4 §1:
  // retention-aware savings).
  coRetained?: boolean;
  coRetainedVia?: string;
}

export function registerInternOpportunities(server: McpServer): void {
  server.tool(
    'memlab_intern_opportunities',
    'Identify string interning opportunities by grouping duplicated strings by the property name and parent object shape that holds them. Shows total savings per (property × shape) combination — the key metric for deciding where to add a string interning pool. Replaces the manual workflow of: duplicated_strings → retainer_summary → codebase grep. ' +
      'Retention-aware: flags groups whose duplicated instances are ALSO held by another structure (e.g. a raw array/matrix) as "co-retained" — interning the property there reclaims ~0, so the savings are reported separately and you must dedupe the shared source instead. ' +
      '⚠ Full-heap scan (builds string-duplication groups) — slow and memory-heavy on very large heaps (millions of nodes); raise min_copies / min_savings to bound it.',
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
            groupSamples: number;
            coRetainedSamples: number;
            coRetainedVia?: string;
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
              // How many sampled instances of this string are ALSO referenced
              // by a structure other than the grouping parent (co-retention).
              coRetainedCount: number;
              coRetainedVia?: string;
            }
          >();
          let samplesProcessed = 0;

          for (const nodeId of stats.exampleIds) {
            const node = snapshot.getNodeById(nodeId);
            if (!node) continue;

            // Gather a bounded set of this instance's referrers once, so we can
            // both (a) pick the primary property/context referrer for grouping
            // and (b) detect co-retention: if the exact same string instance is
            // also held by another structure (e.g. a raw array/matrix cell),
            // interning at the property assignment site frees ~nothing because
            // the other referrer keeps the per-row instance alive. This is the
            // difference between a fix that reclaims the bytes and one that
            // reclaims ~0 (Feedback round 4 §1: retention-aware savings).
            const refs = [];
            for (const ref of node.referrers) {
              refs.push(ref);
              if (refs.length >= 8) break;
            }

            // Primary referrer = first property/context edge (assignment site).
            let primary = null;
            for (const ref of refs) {
              if (ref.type === 'property' || ref.type === 'context') {
                primary = ref;
                break;
              }
            }
            if (!primary) continue;
            const parent = primary.fromNode;
            const propName = String(primary.name_or_index);

            // Co-retained if any referrer comes from a different parent node.
            let coRetainedVia: string | undefined;
            for (const ref of refs) {
              if (ref.fromNode.id === parent.id) continue;
              const fromName = ref.fromNode.name || 'Object';
              if (ref.type === 'element') {
                coRetainedVia =
                  (fromName === 'Object' || fromName === ''
                    ? 'Array'
                    : fromName) + '[] (array element)';
              } else if (ref.type === 'property' || ref.type === 'context') {
                coRetainedVia = `${fromName}.${String(ref.name_or_index)}`;
              } else {
                coRetainedVia = `${fromName} (${ref.type})`;
              }
              break;
            }

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
              if (coRetainedVia) {
                dist.coRetainedCount++;
                if (!dist.coRetainedVia) dist.coRetainedVia = coRetainedVia;
              }
            } else {
              groupDist.set(groupKey, {
                sampledCount: 1,
                propName,
                parentProps,
                shapeKey,
                parentId: parent.id,
                sampleRetained: node.retainedSize,
                coRetainedCount: coRetainedVia ? 1 : 0,
                coRetainedVia,
              });
            }
            samplesProcessed++;
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
              existing.groupSamples += dist.sampledCount;
              existing.coRetainedSamples += dist.coRetainedCount;
              if (!existing.coRetainedVia && dist.coRetainedVia) {
                existing.coRetainedVia = dist.coRetainedVia;
              }
            } else {
              groupMap.set(groupKey, {
                propertyName: dist.propName,
                parentShapeProps: dist.parentProps,
                parentShapeKey: dist.shapeKey,
                strings: new Map([[value, {count: trueCount, size: trueSize}]]),
                totalCopies: trueCount,
                totalSize: trueSize,
                exampleParentId: dist.parentId,
                groupSamples: dist.sampledCount,
                coRetainedSamples: dist.coRetainedCount,
                coRetainedVia: dist.coRetainedVia,
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

          // Co-retained when the majority of sampled instances are also held by
          // another structure — interning the property alone reclaims ~0.
          const coRetained =
            g.coRetainedSamples > 0 &&
            g.coRetainedSamples >= g.groupSamples * 0.5;

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
            coRetained,
            coRetainedVia: coRetained ? g.coRetainedVia : undefined,
          });
        }

        groups.sort((a, b) => b.savingsIfInterned - a.savingsIfInterned);
        const shown = groups.slice(0, limit);

        if (shown.length === 0) {
          return toolResult(
            `No significant interning opportunities found (min ${formatNumber(min_copies)} copies, min ${formatBytes(min_savings)} savings). Try lowering thresholds.`,
          );
        }

        // Detect partial interning patterns (Feedback #3) and, while we're here,
        // mark which groups' savings are CROSS-load (not capturable by a per-load
        // intern pool) so the headline can split the two (Feedback round 3 §1c).
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

          g.crossLoad = true;
          const perPoolSavings = g.savingsIfInterned;
          partialInternAlerts.push(
            `⚠️ **\`.${g.propertyName}\` on \`${g.parentShape.length > 50 ? g.parentShape.slice(0, 47) + '…}' : g.parentShape}\`:** ` +
              `${formatNumber(g.uniqueStrings)} unique strings each duplicated ~${median}× — ` +
              `suggests **${median} independent intern pools** instead of one shared pool. ` +
              `Consolidating into a single shared pool would save ~${formatBytes(perPoolSavings)}.`,
          );
        }

        // Split savings three ways (Feedback round 4 §1 — retention-aware):
        //  • co-retained — the duplicated instances are ALSO held by another
        //    structure, so interning the property reclaims ~0; the shared
        //    source must be deduped/dropped. Reported separately so the figure
        //    is not mistaken for an easy per-property win.
        //  • within-load — capturable by a per-load/per-request intern pool.
        //  • cross-load — needs a shared/module-scope pool (Feedback round 3 §1c).
        const coRetainedSavings = shown
          .filter(g => g.coRetained)
          .reduce((sum, g) => sum + g.savingsIfInterned, 0);
        const withinLoadSavings = shown
          .filter(g => !g.crossLoad && !g.coRetained)
          .reduce((sum, g) => sum + g.savingsIfInterned, 0);
        const crossLoadSavings = shown
          .filter(g => g.crossLoad && !g.coRetained)
          .reduce((sum, g) => sum + g.savingsIfInterned, 0);
        const totalSavings =
          withinLoadSavings + crossLoadSavings + coRetainedSavings;
        const pctOf = (n: number): string =>
          totalSize > 0
            ? ` (${((n / totalSize) * 100).toFixed(1)}% of heap)`
            : '';
        const pctOfHeap = pctOf(totalSavings);

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
            `.${g.propertyName}${g.coRetained ? ' ⚠' : ''}`,
            shape,
            formatNumber(g.uniqueStrings),
            formatNumber(g.totalCopies),
            formatBytes(g.totalSize),
            formatBytes(g.savingsIfInterned),
            pct,
            `@${g.exampleParentId}`,
          ];
        });

        const headerLines: string[] = [
          `# String Interning Opportunities`,
          '',
          `**Total duplication across top ${shown.length} groups: ${formatBytes(totalSavings)}${pctOfHeap}**`,
          `- **Within-load (capturable by a per-load/per-request intern pool): ${formatBytes(withinLoadSavings)}${pctOf(withinLoadSavings)}**`,
        ];
        if (coRetainedSavings > 0) {
          headerLines.push(
            `- **⚠ Co-retained (interning the property reclaims ~0 — these instances are ALSO held by another structure, e.g. a raw array/matrix; dedupe at that shared source or drop it): ${formatBytes(coRetainedSavings)}${pctOf(coRetainedSavings)}**`,
          );
        }
        if (crossLoadSavings > 0) {
          headerLines.push(
            `- **Cross-load (NOT capturable by a per-request pool — needs a shared/module-scope pool or a retention/concurrency fix): ${formatBytes(crossLoadSavings)}${pctOf(crossLoadSavings)}**`,
          );
        }
        const coRetainedGroups = shown.filter(g => g.coRetained);
        const lines = [
          ...headerLines,
          '',
          markdownTable(headers, rows, rightCols),
          '',
        ];
        if (coRetainedGroups.length > 0) {
          lines.push(
            '⚠ = co-retained: the duplicated values are also held by another structure; see the Co-retained section below.',
            '',
          );
        }

        // Co-retained groups: interning the property frees ~0 (Feedback round 4 §1).
        if (coRetainedGroups.length > 0) {
          lines.push(
            '## ⚠ Co-retained — interning the property will NOT reclaim these',
            '',
            'Each duplicated value below is also referenced by another structure, so deduping it at the property assignment site frees ~nothing — the other referrer keeps every per-row instance alive. Dedupe at the **shared source** instead (e.g. intern the raw array/matrix cells at ingestion, or drop that structure once parsed). Confirm with `memlab_get_referrers` on an example instance.',
            '',
          );
          for (const g of coRetainedGroups) {
            const shape =
              g.parentShape.length > 50
                ? g.parentShape.slice(0, 47) + '…}'
                : g.parentShape;
            lines.push(
              `- \`.${g.propertyName}\` on \`${shape}\` — ${formatBytes(g.savingsIfInterned)}; each instance also retained via **${g.coRetainedVia ?? 'another structure'}**`,
            );
          }
          lines.push('');
        }

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
          ...(coRetainedGroups.length > 0
            ? [
                '- For ⚠ co-retained groups: run `memlab_get_referrers` on an example instance to find the shared owner, then dedupe at that source (the property-level pool above will not help).',
              ]
            : []),
        );

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
