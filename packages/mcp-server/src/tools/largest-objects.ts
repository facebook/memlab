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
import {nodeRef, structuredResult} from '../structured.js';
import {offsetParam, openPageFooter} from '../pagination.js';
import {getSnapshot} from '../heap-state.js';
import {
  isNodeWorthInspecting,
  filterLargestObjects,
  SubtreeCollapser,
  truncateNodeName,
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
} from '../utils.js';

function sanitizeForTable(s: string): string {
  return s.replace(/[\n\r\t]/g, ' ').replace(/\|/g, '¦');
}

function getContentPreview(node: IHeapNode): string {
  if (node.isString) {
    const strNode = node.toStringNode();
    if (strNode) {
      const val = strNode.stringValue;
      const preview = val.length > 60 ? val.slice(0, 60) + '…' : val;
      return sanitizeForTable(preview);
    }
  }
  // For objects/arrays, show first few property names
  const props: string[] = [];
  for (const edge of node.references) {
    if (
      edge.type === 'property' ||
      edge.type === 'element' ||
      edge.type === 'shortcut'
    ) {
      props.push(String(edge.name_or_index));
      if (props.length >= 4) break;
    }
  }
  if (props.length > 0) {
    const more = node.edge_count > props.length ? ', …' : '';
    return `{${props.join(', ')}${more}}`;
  }
  return '';
}

export function registerLargestObjects(server: McpServer): void {
  server.tool(
    'memlab_largest_objects',
    'Find the top N objects by retained size in the loaded heap snapshot. Filters out internal/meta objects. Use node_type to filter to a specific type (e.g., "object", "closure") or exclude_types to remove noisy types (e.g., "string"). Shows a content preview for each node. By default it collapses multiple views of the SAME dominator subtree (e.g. Client → Request → … → Map all at one retained size on a single in-flight request) into one representative row so the list is not dominated by ~20 duplicate rows; pass collapse_subtrees:false to see every node.',
    {
      limit: z
        .number()
        .optional()
        .default(25)
        .describe('Maximum number of objects to return (default 25)'),
      offset: offsetParam(),
      node_type: z
        .string()
        .optional()
        .describe(
          'Only include this node type (e.g., "object", "closure", "string", "array", "native", "code"). Types that are filtered out of the default view (array/native/code/synthetic/hidden) ARE returned when requested explicitly.',
        ),
      exclude_types: z
        .string()
        .optional()
        .describe(
          'Comma-separated node types to exclude (e.g., "string,concatenated string"). Useful to filter out large strings dominating the list.',
        ),
      collapse_subtrees: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Collapse nodes that are different views of the same dominator subtree (same retained size + one dominates the other) into a single representative row, annotated with how many views were folded in (default true). Set false to see every node, including all internal nodes of one big subtree.',
        ),
    },
    async ({limit, offset, node_type, exclude_types, collapse_subtrees}) => {
      try {
        const snapshot = getSnapshot();

        const excludeSet = exclude_types
          ? new Set(exclude_types.split(',').map(s => s.trim()))
          : null;

        // When collapsing, over-fetch candidates so a single big subtree's many
        // same-retained-size views don't crowd out distinct subtrees before
        // dedup. Bounded so the retained-size sort stays cheap on huge heaps.
        const start = Math.max(0, offset);
        // Collapsing compares each candidate with its near-equal neighbours
        // through dominator walks; that is for the top of the list, not for
        // paging thousands of rows deep.
        const MAX_COLLAPSE_OFFSET = 1000;
        if (collapse_subtrees && start > MAX_COLLAPSE_OFFSET) {
          return errorResult(
            new Error(
              `\`offset\` ${start} is deeper than collapse mode pages (${MAX_COLLAPSE_OFFSET}). Pass \`collapse_subtrees: false\`, or use memlab_query_objects, which pages any depth.`,
            ),
          );
        }
        const want = start + limit;
        // One extra row tells whether a next page exists.
        const fetchLimit = collapse_subtrees
          ? Math.min(Math.max(want * 6, want + 30), 300 + start * 6)
          : want + 1;

        const fetch = (n: number) =>
          filterLargestObjects(
            snapshot,
            (node: IHeapNode) => {
              // An explicit node_type request overrides the default-view type
              // filter, so normally-suppressed types are still reachable.
              if (
                !isNodeWorthInspecting(node, {
                  allowBlockedTypes: node_type != null,
                })
              )
                return false;
              if (node_type && node.type !== node_type) return false;
              if (excludeSet && excludeSet.has(node.type)) return false;
              return true;
            },
            n,
          );
        const candidates = fetch(fetchLimit);
        let all: Array<{node: IHeapNode; mergedCount: number}>;
        let read = candidates.length;
        let capped = false;
        if (!collapse_subtrees) {
          all = candidates
            .slice(0, want + 1)
            .map(node => ({node, mergedCount: 0}));
        } else {
          const collapser = new SubtreeCollapser();
          for (const c of candidates) collapser.push(c);
          capped = candidates.length >= fetchLimit;
          // Collapse folds a capped candidate list, so too few groups may only
          // mean the cap was reached: read further before deciding whether a
          // next page exists. A page an earlier call offered must not come
          // back empty, so while this page has no row yet, keep reading until
          // it has one or the list is exhausted. Candidates are a total order
          // (size, then scan order), so one longer fetch starts with the ones
          // already read, and feeding it in steps reproduces every group an
          // earlier call saw: one more heap scan, not one per step.
          if (capped && collapser.rows.length <= want) {
            // The loop doubles what it has read: twice for any page, then on
            // only while a deep page has no row. Fetch enough for the two
            // doublings, and the whole budget only if a deep page needs it.
            const MAX_CANDIDATES = 200_000;
            let limit = Math.min(read * 4, MAX_CANDIDATES);
            let more = fetch(limit);
            for (
              let i = 0;
              collapser.rows.length <= want &&
              (i < 2 || collapser.rows.length <= start);
              i++
            ) {
              if (read >= more.length) {
                // A list shorter than its fetch limit is the whole list.
                if (more.length < limit || limit >= MAX_CANDIDATES) break;
                limit = MAX_CANDIDATES;
                more = fetch(limit);
                if (read >= more.length) break;
              }
              const next = Math.min(read * 2, more.length);
              for (let j = read; j < next; j++) collapser.push(more[j]);
              read = next;
            }
            capped = read < more.length || more.length >= limit;
          }
          all = collapser.rows.slice(0, want + 1);
        }
        const groups = all.slice(start, want);
        // A next page past MAX_COLLAPSE_OFFSET would be refused.
        const pastDepth =
          collapse_subtrees && all.length > want && want > MAX_COLLAPSE_OFFSET;
        const hasMore = all.length > want && !pastDepth;
        // Still capped with too few groups: say where collapse mode stopped
        // rather than offer a next page that may be empty.
        const stoppedAtCap = capped && all.length <= want;

        const headers = [
          'ID',
          'Name',
          'Type',
          'Self Size',
          'Retained Size',
          'Preview',
        ];
        const rightCols = new Set([3, 4]);
        const rows = groups.map(({node: n, mergedCount}) => {
          const mergeNote =
            mergedCount > 0
              ? `(+${mergedCount} more view${mergedCount > 1 ? 's' : ''} of this subtree) `
              : '';
          return [
            `@${n.id}`,
            truncateNodeName(n.name, n.type, n.self_size, 60),
            n.type,
            formatBytes(n.self_size),
            formatBytes(n.retainedSize),
            mergeNote + getContentPreview(n),
          ];
        });

        const filterParts: string[] = [];
        if (node_type) filterParts.push(`type=${node_type}`);
        if (exclude_types) filterParts.push(`excluding ${exclude_types}`);
        const filterNote =
          filterParts.length > 0 ? ` (${filterParts.join(', ')})` : '';
        const collapsed = groups.reduce((s, g) => s + g.mergedCount, 0);
        const collapseNote =
          (collapse_subtrees && collapsed > 0
            ? `\n_Collapsed ${collapsed} same-subtree view(s) into their representative rows; pass collapse_subtrees:false to see every node._`
            : '') +
          (stoppedAtCap && rows.length > 0
            ? `\n_Collapse mode read the largest ${formatNumber(read)} objects; smaller ones are not grouped here. Pass \`collapse_subtrees: false\` to page past them._`
            : '') +
          (pastDepth
            ? `\n_Collapse mode pages to offset ${MAX_COLLAPSE_OFFSET}; pass \`collapse_subtrees: false\` to continue past it._`
            : '');
        if (rows.length === 0 && start > 0 && stoppedAtCap) {
          return errorResult(
            new Error(
              `\`offset\` ${start} is past the ${formatNumber(all.length)} group(s) collapse mode made from the largest ${formatNumber(read)} objects${filterNote}. Pass \`collapse_subtrees: false\` to page further.`,
            ),
          );
        }
        if (rows.length === 0 && start > 0) {
          return errorResult(
            new Error(
              `\`offset\` ${start} is past the last object${filterNote}; use a smaller offset.`,
            ),
          );
        }
        const footer = openPageFooter(start, rows.length, hasMore);
        return structuredResult(
          `Top ${rows.length} objects by retained size${filterNote}\n\n${markdownTable(headers, rows, rightCols)}${collapseNote}` +
            (footer ? `\n\n${footer}` : ''),
          {
            objects: groups.map(g => ({
              ...nodeRef(g.node),
              merged_views: g.mergedCount,
            })),
            pagination: {
              offset: start,
              page_size: limit,
              next_offset: hasMore ? start + rows.length : null,
            },
          },
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
