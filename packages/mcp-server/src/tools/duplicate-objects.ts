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
import {
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
  suggestionsSuppressed,
  objectContentSignature,
  IDENTITY_PROPS,
} from '../utils.js';

interface SigGroup {
  count: number;
  totalSelf: number;
  exampleId: number;
}

function readTypename(node: IHeapNode): string | null {
  for (const edge of node.references) {
    if (
      edge.type === 'property' &&
      String(edge.name_or_index) === '__typename'
    ) {
      const t = edge.toNode;
      return t.isString ? (t.toStringNode()?.stringValue ?? null) : null;
    }
  }
  return null;
}

export function registerDuplicateObjects(server: McpServer): void {
  server.tool(
    'memlab_duplicate_objects',
    'Find structurally-identical DUPLICATE objects — instances that carry the same content repeated many times, which a class histogram or shape histogram cannot see (they group by class or by property-NAME set, not by VALUE). Groups object instances by a shallow content signature (sorted property names + each scalar value; object-valued props marked generically) and reports, per signature, the instance count and the reclaimable own-bytes of the redundant copies. ' +
      'This surfaces "materialize a canonical/default record once", "share a frozen default", or "intern the object" wins — e.g. thousands of normalized store records that are all the same all-default spec. ' +
      'Scope the scan with `class_name` (constructor, e.g. "Object") and/or `typename` (the `__typename` property value, e.g. "AdCreativeFeatureSpecAttachment") — for normalized GraphQL/Relay stores `typename` is usually what you want since every record is a generic `Object`. ' +
      'Per-instance identity fields (id, __id, __ref, key, clientMutationId) are EXCLUDED from the signature by default so records that differ only by their data-id still collapse together (override with `ignore_properties`). ' +
      'Caveat: numeric property VALUES are not recoverable from the heap-snapshot format, so a number field contributes only a generic marker — two objects differing only in a numeric field (SMI or double) hash to the same signature and are reported as duplicates. String, boolean, null and object-valued properties are compared (objects generically, so nested content is not).',
    {
      class_name: z
        .string()
        .optional()
        .describe(
          'Restrict to objects with this constructor name (e.g. "Object"). Omit to scan every object-type node.',
        ),
      typename: z
        .string()
        .optional()
        .describe(
          'Restrict to objects whose `__typename` property equals this value (normalized GraphQL/Relay records). Combine with or instead of class_name.',
        ),
      min_count: z
        .number()
        .optional()
        .default(50)
        .describe(
          'Only report signature groups with at least this many instances (default 50). Raise to focus on the most-duplicated content.',
        ),
      min_dup_ratio: z
        .number()
        .optional()
        .describe(
          'Only report signature groups whose instance count is at least this multiple of 1 distinct content (i.e. count ≥ min_dup_ratio). Optional extra filter on top of min_count.',
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of signature groups to return (default 20).'),
      max_string_len: z
        .number()
        .optional()
        .default(40)
        .describe(
          'Cap on the length of string values folded into the signature (default 40). Two strings that differ only past this cap are treated as equal — lower it to be more lenient, raise it to be stricter.',
        ),
      ignore_properties: z
        .array(z.string())
        .optional()
        .describe(
          'Property names to EXCLUDE from the content signature — per-instance identity/unique fields (a data-id, a key) that would otherwise make every record look distinct and hide real duplicates. Defaults to id, __id, __ref, key, clientMutationId. Pass [] to include every property.',
        ),
    },
    async ({
      class_name,
      typename,
      min_count,
      min_dup_ratio,
      limit,
      max_string_len,
      ignore_properties,
    }) => {
      try {
        const snapshot = getSnapshot();
        const ignoreProps = ignore_properties
          ? new Set(ignore_properties)
          : IDENTITY_PROPS;
        const groups = new Map<string, SigGroup>();
        let scopeCount = 0;
        let scopeSelf = 0;

        snapshot.nodes.forEach((node: IHeapNode) => {
          if (node.type !== 'object') return;
          if (node.id <= 3) return;
          if (class_name && node.name !== class_name) return;
          if (typename && readTypename(node) !== typename) return;

          const sig = objectContentSignature(node, {
            maxStringLen: max_string_len,
            ignoreProps,
          });
          if (sig === '') return; // no own properties — nothing to dedupe on

          scopeCount++;
          scopeSelf += node.self_size;
          const g = groups.get(sig);
          if (g) {
            g.count++;
            g.totalSelf += node.self_size;
          } else {
            groups.set(sig, {
              count: 1,
              totalSelf: node.self_size,
              exampleId: node.id,
            });
          }
        });

        if (scopeCount === 0) {
          return toolResult(
            'No matching objects found. Loosen `class_name` / `typename`, or check the value with `memlab_property_distribution(property:"__typename")` / `memlab_class_histogram`.',
          );
        }

        const distinct = groups.size;
        // Reclaimable = own-bytes of the redundant copies (all but one per
        // signature) — what deduping/sharing a canonical instance would free.
        // Shared child subtrees are NOT included (this is a lower bound on the
        // structural win, an honest own-bytes figure).
        let totalReclaimable = 0;
        for (const g of groups.values()) {
          totalReclaimable += g.totalSelf * ((g.count - 1) / g.count);
        }

        const ranked = [...groups.entries()]
          .map(([sig, g]) => ({
            sig,
            ...g,
            reclaimable: g.totalSelf * ((g.count - 1) / g.count),
          }))
          .filter(g => g.count >= min_count)
          .filter(g => min_dup_ratio == null || g.count >= min_dup_ratio);
        ranked.sort((a, b) => b.reclaimable - a.reclaimable);
        const shown = ranked.slice(0, limit);

        const scopeLabel =
          [
            class_name ? `class \`${class_name}\`` : null,
            typename ? `__typename \`${typename}\`` : null,
          ]
            .filter(Boolean)
            .join(' + ') || 'all objects';

        const lines: string[] = [
          `## Duplicate objects — ${scopeLabel}`,
          '',
          `**${formatNumber(scopeCount)}** instances in scope collapse to **${formatNumber(distinct)}** distinct contents ` +
            `(dup ratio **${(scopeCount / Math.max(1, distinct)).toFixed(1)}×**). ` +
            `Reclaimable own-bytes if deduped to one-per-content: **~${formatBytes(totalReclaimable)}** ` +
            `of ${formatBytes(scopeSelf)} total self size.`,
          '',
        ];

        if (shown.length === 0) {
          lines.push(
            `No single content is shared by ≥ ${min_count} instances` +
              (min_dup_ratio != null ? ` (and ≥ ${min_dup_ratio}× dup)` : '') +
              '. The instances are structurally varied (real data), not duplicates. Lower `min_count` to see smaller groups.',
          );
          return toolResult(lines.join('\n'));
        }

        const headers = [
          'Count',
          'Self each',
          'Reclaimable',
          'Example',
          'Signature',
        ];
        const rightCols = new Set([0, 1, 2]);
        const rows = shown.map(g => {
          const avg = g.totalSelf / g.count;
          const sigShown = g.sig.length > 90 ? g.sig.slice(0, 90) + '…' : g.sig;
          return [
            formatNumber(g.count),
            formatBytes(avg),
            formatBytes(g.reclaimable),
            `@${g.exampleId}`,
            sigShown,
          ];
        });
        lines.push(markdownTable(headers, rows, rightCols));

        if (!suggestionsSuppressed()) {
          lines.push(
            '',
            '**Suggested next steps:**',
            `- Inspect a duplicate: \`memlab_object_shape(${shown[0].exampleId})\``,
            `- Trace why they are retained: \`memlab_retainer_trace(${shown[0].exampleId})\``,
            '- If these are normalized store records, the fix is usually at the resolver/normalizer: return a shared canonical instance (or null) for all-default content instead of materializing one per key.',
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
