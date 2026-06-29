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
import type {IHeapEdge} from '@memlab/core';
import {z} from 'zod';
import {
  getSnapshot,
  getSnapshotMetadata,
  getSessionConfig,
} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';

// V8 splits a single logical object's storage across several internal backing
// structures: a `system / PropertyArray` (named props once the object grows past
// the inline slot count), `(object properties)` / `(object elements)` arrays, and
// `(sliced string)` views. A string reached through ANY of these is still held by
// ONE logical object via ONE assignment site — interning the property at the parse
// boundary collapses it (Feedback round 5 §1/§2). Only a referrer that is a
// genuinely INDEPENDENT user structure (a real Array element, or a property on a
// different logical object) keeps the per-row instance alive after interning and
// therefore makes the savings non-capturable. This predicate identifies the
// former so it is NOT mistaken for the latter.
function isOwnStorageReferrer(ref: IHeapEdge): boolean {
  // Hidden/internal edges are V8 wiring of the object's own representation
  // (this covers the "(object properties) (internal)", "(object elements)
  // (internal)", "(sliced string) (internal)", and "Object (internal)" buckets
  // the feedback flagged as ambiguous — all of them are own-storage).
  if (ref.type === 'hidden' || ref.type === 'internal') return true;
  const fromName = ref.fromNode.name || '';
  return (
    fromName === 'system / PropertyArray' ||
    fromName === 'system / SlicedString' ||
    fromName.startsWith('(object properties)') ||
    fromName.startsWith('(object elements)') ||
    fromName.startsWith('(sliced string)')
  );
}

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
  // True when the duplicated instances are ALSO retained by an INDEPENDENT
  // structure (e.g. a raw array / matrix held by a different object). Interning
  // at this property reclaims ~nothing — the other referrer keeps every per-row
  // instance alive — so the shared source must be deduped or dropped instead
  // (Feedback round 4 §1: retention-aware savings). A string reached only via
  // the SAME object's own V8 backing store (PropertyArray / object-elements /
  // sliced-string) is NOT co-retained — interning still collapses it
  // (Feedback round 5 §1/§2; see isOwnStorageReferrer).
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
      summary_only: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Triage mode: return only the headline savings split (within-load / co-retained / cross-load), a one-line verdict, and the ranked group table — dropping the per-group top-strings, the "How to fix" block, and "Next steps". Ideal for screening many snapshots without flooding context.',
        ),
    },
    async ({limit, min_copies, min_savings, summary_only}) => {
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
            // also held by an INDEPENDENT structure (e.g. a raw array/matrix
            // cell on a different object), interning at the property assignment
            // site frees ~nothing because the other referrer keeps the per-row
            // instance alive. This is the difference between a fix that reclaims
            // the bytes and one that reclaims ~0 (Feedback round 4 §1:
            // retention-aware savings).
            // Collect up to 8 referrers via the streaming iterator, NOT the
            // `node.referrers` getter: that getter materializes a JS array of
            // ALL incoming edges on every access, so a string referenced N times
            // (common low-cardinality values are referenced 1000s of times) pays
            // O(N) per sample. forEachReferrer stops after 8 without building the
            // full array.
            const refs: IHeapEdge[] = [];
            node.forEachReferrer(ref => {
              refs.push(ref);
              if (refs.length >= 8) return {stop: true};
            });

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

            // Co-retained ONLY if a referrer comes from a genuinely independent
            // structure. A referrer that is the same object's own V8 backing
            // store (PropertyArray / object-elements / sliced-string, or any
            // hidden/internal edge) still collapses under interning, so it must
            // NOT be counted as co-retention — counting it was discounting the
            // biggest real wins by ~2× (Feedback round 5 §1/§2).
            let coRetainedVia: string | undefined;
            for (const ref of refs) {
              if (ref.fromNode.id === parent.id) continue;
              if (isOwnStorageReferrer(ref)) continue;
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

            // Fingerprint the parent shape from up to 12 property names.
            // CRITICAL: never touch `parent.references` — that getter
            // materializes a JS array of ALL outgoing edges on every access, so
            // on a giant parent (a map/config object, or one with a huge backing
            // store) it is O(edge_count) PER SAMPLE PER duplicated string and
            // wedges the tool (observed: avg 185k, max 504k edges, ~390k of
            // ~978k samples on one real heap). `edge_count` is O(1): skip shape
            // detection for oversized parents (they are not the row-shaped
            // objects we intern — grouping them by node name is enough), and for
            // the rest use the non-materializing `forEachReference` iterator with
            // an absolute visit cap as a backstop.
            const parentProps: string[] = [];
            const PARENT_EDGE_GUARD = 1024;
            const PARENT_SCAN_CAP = 256;
            if (parent.edge_count <= PARENT_EDGE_GUARD) {
              let scanned = 0;
              parent.forEachReference(edge => {
                if (++scanned > PARENT_SCAN_CAP) return {stop: true};
                if (edge.type === 'property') {
                  parentProps.push(String(edge.name_or_index));
                  if (parentProps.length >= 12) return {stop: true};
                }
              });
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

        // Duplication factor (copies ÷ unique) per group — the single best
        // "is this cross-load?" signal: a value held ~N× by N same-shape objects
        // each from a different call/load won't collapse under a per-request pool
        // (Feedback round 5 §3). Reported as a column so the agent can eyeball it.
        const fmtDup = (copies: number, unique: number): string => {
          if (unique <= 0) return '-';
          const f = copies / unique;
          return f >= 10 ? `${Math.round(f)}×` : `${f.toFixed(1)}×`;
        };

        const headers = [
          'Property',
          'Parent Shape',
          'Unique Strings',
          'Total Copies',
          'Dup ×',
          'Total Size',
          'Savings',
          '% Heap',
          'Example Parent',
        ];
        const rightCols = new Set([2, 3, 4, 5, 6, 7]);
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
            `.${g.propertyName}${g.coRetained ? ' ⚠' : ''}${g.crossLoad ? ' ⤫' : ''}`,
            shape,
            formatNumber(g.uniqueStrings),
            formatNumber(g.totalCopies),
            fmtDup(g.totalCopies, g.uniqueStrings),
            formatBytes(g.totalSize),
            formatBytes(g.savingsIfInterned),
            pct,
            `@${g.exampleParentId}`,
          ];
        });

        // Retention/concurrency-bug signature (Feedback round 6 §4): a heap
        // dominated by CROSS-load groups whose copies ÷ unique ≈ 2.0 is two full
        // copies of the same dataset resident at once (a stale+fresh
        // double-buffer / setInterval retention), NOT a value duplicated within a
        // single parse. A per-request intern pool cannot collapse it — the fix is
        // to stop the double retention at the source. Detect it purely from the
        // already-computed group counts (no extra heap traversal) so the verdict
        // can call it out explicitly instead of leaving the agent to infer it.
        const isExactlyTwoX = (g: InternGroup): boolean => {
          if (g.uniqueStrings <= 0) return false;
          const f = g.totalCopies / g.uniqueStrings;
          return f >= 1.8 && f <= 2.2;
        };
        const twoXCrossLoadSavings = shown
          .filter(g => g.crossLoad && !g.coRetained && isExactlyTwoX(g))
          .reduce((sum, g) => sum + g.savingsIfInterned, 0);
        const retentionBugSuspected =
          crossLoadSavings > 0 &&
          crossLoadSavings >= withinLoadSavings &&
          crossLoadSavings >= coRetainedSavings &&
          twoXCrossLoadSavings >= crossLoadSavings * 0.5;

        // One-line verdict (Feedback round 5 §9): which bucket dominates decides
        // the fix shape, so lead with it before the detail.
        let verdict: string;
        if (
          coRetainedSavings >= withinLoadSavings &&
          coRetainedSavings >= crossLoadSavings &&
          coRetainedSavings > 0
        ) {
          verdict = `Verdict: mostly **co-retained** (${formatBytes(coRetainedSavings)}) — interning the property won't help; dedupe at the shared source.`;
        } else if (
          crossLoadSavings >= withinLoadSavings &&
          crossLoadSavings > 0
        ) {
          verdict = retentionBugSuspected
            ? `Verdict: ⚠ likely **retention/concurrency bug** (NOT interning) — ${formatBytes(twoXCrossLoadSavings)} of cross-load duplication at ~2.0× (copies ÷ unique), i.e. two copies of the same dataset held at once (stale+fresh double-buffer / setInterval). A per-request intern pool will NOT help; fix the double retention at the source.`
            : `Verdict: mostly **cross-load** (${formatBytes(crossLoadSavings)}) — a per-request pool won't collapse it; needs a shared/module-scope pool or a retention fix.`;
        } else if (withinLoadSavings > 0) {
          verdict = `Verdict: **${formatBytes(withinLoadSavings)} capturable** by a per-load/per-request intern pool at the parse boundary.`;
        } else {
          verdict = 'Verdict: no clearly-capturable interning savings.';
        }

        const headerLines: string[] = [
          `# String Interning Opportunities`,
          '',
          verdict,
          '',
          `**Total duplication across top ${shown.length} groups: ${formatBytes(totalSavings)}${pctOfHeap}**`,
          `- **Within-load (capturable by a per-load/per-request intern pool): ${formatBytes(withinLoadSavings)}${pctOf(withinLoadSavings)}**`,
        ];
        if (coRetainedSavings > 0) {
          headerLines.push(
            `- **⚠ Co-retained (interning the property reclaims ~0 — these instances are ALSO held by an independent structure, e.g. a raw array/matrix on another object; dedupe at that shared source or drop it): ${formatBytes(coRetainedSavings)}${pctOf(coRetainedSavings)}**`,
          );
        }
        if (crossLoadSavings > 0) {
          headerLines.push(
            `- **⤫ Cross-load (NOT capturable by a per-request pool — needs a shared/module-scope pool or a retention/concurrency fix): ${formatBytes(crossLoadSavings)}${pctOf(crossLoadSavings)}**`,
          );
        }
        const coRetainedGroups = shown.filter(g => g.coRetained);
        const lines = [
          ...headerLines,
          '',
          markdownTable(headers, rows, rightCols),
          '',
        ];
        if (coRetainedGroups.length > 0 || crossLoadSavings > 0) {
          lines.push(
            "⚠ = co-retained (interning won't reclaim); ⤫ = cross-load (high Dup ×, needs shared pool).",
            '',
          );
        }

        // Triage mode: stop after the headline split + ranked table. Drops the
        // per-group string lists, partial-interning detail, and the fix recipe
        // — pure waste when screening many snapshots (Feedback round 5 §9).
        if (summary_only) {
          if (coRetainedGroups.length > 0) {
            lines.push(
              '## ⚠ Co-retained — interning the property will NOT reclaim these',
              '',
            );
          }
          for (const g of coRetainedGroups) {
            const shape =
              g.parentShape.length > 50
                ? g.parentShape.slice(0, 47) + '…}'
                : g.parentShape;
            lines.push(
              `- ⚠ \`.${g.propertyName}\` on \`${shape}\` — ${formatBytes(g.savingsIfInterned)} co-retained via **${g.coRetainedVia ?? 'another structure'}**`,
            );
          }
          return toolResult(lines.join('\n'));
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

        // The fix recipe + next steps are "suggestions"; honor the session-level
        // suppress flag so a long sweep doesn't repeat the same boilerplate on
        // every snapshot (Feedback round 5 §9a).
        if (!getSessionConfig().suppressSuggestions) {
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
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
