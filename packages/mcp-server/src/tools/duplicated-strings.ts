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
import {getSnapshot} from '../heap-state.js';
import {withAnonymizedBanner} from '../anonymized-snapshot.js';
import {
  formatBytes,
  errorResult,
  toolResult,
  looksLikeFailurePayload,
  suggestionsSuppressed,
} from '../utils.js';
import {classifyNonProductionString} from '../artifact-classes.js';
import {buildStringIndex, stringIndexIsCached} from '../string-index.js';

export function registerDuplicatedStrings(server: McpServer): void {
  server.tool(
    'memlab_duplicated_strings',
    'Find duplicated string instances in the heap. Shows strings that appear multiple times, ranked by total retained size — a common source of memory waste. Use after memlab_class_histogram shows high string counts. ' +
      '⚠ Full-heap scan — slow and memory-heavy on very large heaps (millions of nodes); raise min_count to bound the work.',
    {
      limit: z
        .number()
        .optional()
        .default(15)
        .describe('Maximum number of results (default 15)'),
      min_count: z
        .number()
        .optional()
        .default(2)
        .describe(
          'Minimum number of copies to include (default 2). Increase to focus on heavily duplicated strings (e.g., 100).',
        ),
      include_node_ids: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Include example node IDs in the output for follow-up with retainer_summary. Omitted by default to save ~20-30 tokens per entry.',
        ),
    },
    async ({limit, min_count, include_node_ids}) => {
      try {
        const snapshot = getSnapshot();

        // Shared with memlab_intern_opportunities, which needs the same
        // value -> {count, size, ids} map. Cached per snapshot, so running the
        // two back to back (the common case) walks every string node once
        // instead of twice.
        const reused = stringIndexIsCached();
        const {byValue: stringMap} = buildStringIndex(snapshot);

        const duplicated = Array.from(stringMap.entries())
          .filter(([, stats]) => stats.count >= min_count)
          .sort((a, b) => b[1].totalSize - a[1].totalSize)
          .slice(0, limit)
          .map(([value, stats]) => {
            const per_copy_size =
              stats.count > 0 ? stats.totalSize / stats.count : 0;
            const potential_savings = (stats.count - 1) * per_copy_size;
            return {
              value:
                value.length > 200 ? value.substring(0, 200) + '...' : value,
              count: stats.count,
              total_size: stats.totalSize,
              total_size_formatted: formatBytes(stats.totalSize),
              potential_savings,
              example_node_ids: stats.exampleIds.slice(0, 3),
              field_context: null as string | null,
              actionability: null as string | null,
              harness_what: null as string | null,
            };
          });

        if (duplicated.length === 0) {
          return toolResult('No duplicated strings found.');
        }

        // For top entries, sample referrer objects to show field context
        for (const d of duplicated.slice(0, 10)) {
          const propCounts = new Map<
            string,
            {count: number; ownerName: string}
          >();
          for (const nodeId of d.example_node_ids) {
            const node = snapshot.getNodeById(nodeId);
            if (!node) continue;
            for (const ref of node.referrers) {
              if (ref.type === 'property' || ref.type === 'context') {
                const propName = String(ref.name_or_index);
                const entry = propCounts.get(propName);
                if (entry) {
                  entry.count++;
                } else {
                  propCounts.set(propName, {
                    count: 1,
                    ownerName: ref.fromNode.name,
                  });
                }
              }
            }
          }
          if (propCounts.size > 0) {
            const topProp = [...propCounts.entries()].sort(
              (a, b) => b[1].count - a[1].count,
            )[0];
            d.field_context = `.${topProp[0]} on \`${topProp[1].ownerName}\` instances`;
          }

          // Classify actionability: app vs framework vs mixed
          let appCount = 0;
          let frameworkCount = 0;
          for (const nodeId of d.example_node_ids) {
            const node = snapshot.getNodeById(nodeId);
            if (!node) continue;
            for (const ref of node.referrers) {
              const fromName = ref.fromNode.name;
              const edgeName = String(ref.name_or_index);
              const isFramework =
                fromName.startsWith('system /') ||
                fromName === 'Module' ||
                fromName === '(object properties)' ||
                edgeName === 'map' ||
                edgeName === 'table' ||
                edgeName === 'elements';
              if (isFramework) {
                frameworkCount++;
              } else {
                appCount++;
              }
            }
          }
          // Non-production content outranks the app/framework split: whether it
          // was injected by the measurement harness or exists only in a DEV
          // build, it is not memory the shipped app has, so it must never be
          // counted toward an interning win (see classifyNonProductionString).
          const nonProd = classifyNonProductionString(d.value);
          if (nonProd != null) {
            d.actionability = 'harness';
            d.harness_what =
              nonProd.kind === 'dev-build'
                ? `${nonProd.what} — DEV build only, absent in production`
                : nonProd.what;
          } else if (appCount > 0 && frameworkCount > 0) {
            d.actionability = 'mixed';
          } else if (frameworkCount > 0) {
            d.actionability = 'framework';
          } else {
            d.actionability = 'app';
          }
        }

        const appActionableCount = duplicated.filter(
          d => d.actionability === 'app' || d.actionability === 'mixed',
        ).length;
        const harnessEntries = duplicated.filter(
          d => d.actionability === 'harness',
        );
        const harnessBytes = harnessEntries.reduce(
          (sum, d) => sum + d.potential_savings,
          0,
        );

        const lines = duplicated.map((d, i) => {
          const val =
            d.value.length > 80 ? d.value.slice(0, 80) + '...' : d.value;
          const nodeIdsPart = include_node_ids
            ? ` (nodes: ${d.example_node_ids.map(id => `@${id}`).join(', ')})`
            : '';
          const context = d.field_context
            ? `\n   commonly held as: ${d.field_context}`
            : '';
          const actionLabel =
            d.actionability === 'harness'
              ? ` [harness — ${d.harness_what ?? 'measurement harness'}; not app memory]`
              : d.actionability
                ? ` [${d.actionability}]`
                : '';
          const savingsLabel =
            d.potential_savings > 0
              ? `, savings: ${formatBytes(d.potential_savings)}`
              : '';
          return `${i + 1}. "${val}" x ${d.count} copies, ${d.total_size_formatted} total${savingsLabel}${actionLabel}${nodeIdsPart}${context}`;
        });
        // Cached failure payloads: duplicated JSON-ish strings carrying an
        // explicit failure/error marker. These are both wasted memory and a
        // signal that an upstream dependency is failing (and that failures are
        // being cached). Feedback round 4 §D.
        const failurePayloads = duplicated.filter(d =>
          looksLikeFailurePayload(d.value),
        );

        const hasHeavyDups = duplicated.some(d => d.count >= 1000);
        const suggestions: string[] = [];
        if (failurePayloads.length > 0) {
          const totalFailureCopies = failurePayloads.reduce(
            (sum, d) => sum + d.count,
            0,
          );
          const failureBytes = failurePayloads.reduce(
            (sum, d) => sum + d.total_size,
            0,
          );
          suggestions.push(
            `⚠️ **Cached failure payloads detected:** ${failurePayloads.length} of the duplicated strings look like cached error/failure responses ` +
              `(${totalFailureCopies.toLocaleString('en-US')} copies, ${formatBytes(failureBytes)}). ` +
              'This usually means an upstream dependency is failing AND those failures are being cached. ' +
              'Check the upstream call (permissions, timeouts, bad input) and avoid caching error responses (or cache them with a short TTL).',
          );
        }
        if (hasHeavyDups) {
          suggestions.push(
            '**Suggested action:** Heavily duplicated strings often come from `JSON.parse()` or API responses. ' +
              'Consider string interning with a `Map<string, string>` pool applied at ingestion time, ' +
              'or deduplicating at the data source.',
          );
        }

        // Harness content is excluded from the headline: the number a caller
        // acts on must be reclaimable from the application.
        const totalSavings = duplicated.reduce(
          (sum, d) =>
            d.actionability === 'harness' ? sum : sum + d.potential_savings,
          0,
        );

        const summaryLine =
          appActionableCount > 0
            ? `${appActionableCount} of ${duplicated.length} entries are app-actionable`
            : `${duplicated.length} entries (all framework-held)`;

        const harnessNote =
          harnessEntries.length > 0
            ? `\n\n⚠️ **${harnessEntries.length} entr${harnessEntries.length === 1 ? 'y' : 'ies'} (${formatBytes(harnessBytes)}) excluded from the total as measurement-harness content** — the CDP/devtools bridge injected into the page to drive this session, not application memory. Interning it reclaims nothing in production.`
            : '';

        // The two string tools answer different questions and their outputs
        // used to restate each other. Say which is which, once, and note that
        // the expensive scan is shared rather than repeated.
        const relatedNote = `\n\n_This is the raw per-VALUE duplication table. \`memlab_intern_opportunities\` groups the same strings by property x parent shape and estimates what a canonical intern pool would actually reclaim (accounting for co-retention and the length cap) — use it to decide whether to write the fix, and this to see the values. It reuses this snapshot's string scan${reused ? ', which was itself already cached' : ''}, so running both costs one pass over the string nodes, not two._`;

        const body = `Duplicated strings (${summaryLine}):\n\n${lines.join('\n')}\n\n**Total interning savings: ${formatBytes(totalSavings)}** (if each string were stored only once, harness content excluded)${harnessNote}${suggestionsSuppressed('memlab_duplicated_strings') ? '' : relatedNote}`;
        return toolResult(
          withAnonymizedBanner(
            snapshot,
            suggestions.length > 0
              ? `${body}\n\n---\n\n${suggestions.join('\n')}`
              : body,
          ),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
