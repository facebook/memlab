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
  /** A few members, so a suspicious group can be re-read and disproven. */
  sampleIds: number[];
}

/**
 * How much of a signature actually compared VALUES.
 *
 * A signature part is either a real value (`x=s:foo`, `x=true`, `x=null`, …) or
 * a generic marker (`x=o` for any object, `x=n` for any number — the snapshot
 * format carries no numeric value). A group whose every part is generic has
 * matched on SHAPE ALONE: it says the members have the same property names and
 * the same broad types, and nothing whatsoever about their contents.
 *
 * This matters because such a group was still reported with a large
 * "reclaimable" figure, and that figure is meaningless. Two shapes that recur
 * in real captures show why:
 *
 * - A module-registry record, whose distinguishing fields are its name (an
 *   identity property, excluded by default) plus a factory function and a
 *   dependency array (both object-valued, so both generic). Tens of thousands
 *   of records for DIFFERENT modules therefore share one signature.
 * - A doubly-linked-list cache node, `{version, next, prev, value}` — every
 *   field numeric or object-valued, so the signature has NO comparable part at
 *   all, and head/tail sentinels group together with live entries.
 *
 * Neither is dedupable, and on one measured capture the two of them accounted
 * for most of a reported tens-of-MB "optimization" that did not exist.
 */
function countComparableParts(sig: string): {
  comparable: number;
  generic: number;
} {
  let comparable = 0;
  let generic = 0;
  for (const part of sig.split('|')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const v = part.slice(eq + 1);
    if (v === 'o' || v === 'n') {
      generic++;
    } else {
      comparable++;
    }
  }
  return {comparable, generic};
}

/**
 * Read the identity properties that were EXCLUDED from the signature.
 *
 * The exclusion is what makes duplicate detection work on normalized store
 * records (they differ only by data-id). It is also what lets genuinely
 * different records collapse together, so for any group we are about to report
 * it is worth spending a few reads to check: if two members disagree on an
 * excluded identity value, they are not duplicates and saying so is the whole
 * job of this tool.
 */
function readIgnoredIdentity(
  node: IHeapNode,
  ignore: ReadonlySet<string>,
): string | null {
  const parts: string[] = [];
  for (const edge of node.references) {
    if (edge.type !== 'property') continue;
    const name = String(edge.name_or_index);
    if (!ignore.has(name)) continue;
    const t = edge.toNode;
    const value = t.isString ? t.toStringNode()?.stringValue : undefined;
    // An identity that could not be read must never look like agreement.
    // Skipping it (or substituting '') made two nodes whose ids are numbers,
    // object references, or simply unresolvable collapse to the same part —
    // so `{id:"A"} + {unreadable} + {unreadable}` scored as one identity and
    // the group passed the disproof it should have failed. The target node id
    // is unique per member, so an unreadable identity now reads as a
    // DISAGREEMENT, which is the conservative direction.
    parts.push(
      value != null ? `${name}=s:${value}` : `${name}=?${String(t.id)}`,
    );
  }
  return parts.length > 0 ? parts.sort().join('|') : null;
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
      'IMPORTANT — read the Verdict column before quoting any number. Numeric property VALUES are not recoverable from the heap-snapshot format and object-valued properties are compared only generically, so a signature made entirely of `=n`/`=o` markers matches on SHAPE alone and proves nothing about content. Those groups are reported as `shape only`, are EXCLUDED from the reclaimable total, and their byte figure is not a win. A shape-only or partial group whose sampled members ALSO disagree on an excluded identity property (e.g. `id`) is reported as `NOT duplicates`; a `content` group is not, since collapsing records that differ only by their data-id is the point of the exclusion. This matters in practice: a reported tens-of-MB "dedup" opportunity turned out to be entirely shape-only and NOT-duplicate groups — module-registry records for different modules, and linked-list cache-node sentinels grouped with live entries.',
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
            // Three is enough to disprove a group, and bounds the memory this
            // bookkeeping costs on a heap with ~80k signature groups. Keep the
            // first two and let the third track the MOST RECENT member, so the
            // sample spans the traversal instead of being three neighbours:
            // V8 allocates related objects contiguously, so the first three of
            // a group are the ones most likely to agree by accident.
            if (g.sampleIds.length < 3) g.sampleIds.push(node.id);
            else g.sampleIds[2] = node.id;
          } else {
            groups.set(sig, {
              count: 1,
              totalSelf: node.self_size,
              exampleId: node.id,
              sampleIds: [node.id],
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
        //
        // Split by whether the signature compared any VALUES. A shape-only
        // group's figure is not a win of any size, so folding it into one
        // headline number is how a phantom tens-of-MB "optimization" gets
        // filed. The two totals are reported separately and the shape-only one
        // is never called reclaimable.
        let totalReclaimable = 0;
        let partialBytes = 0;
        let partialGroups = 0;
        let shapeOnlyBytes = 0;
        let shapeOnlyGroups = 0;
        for (const [sig, g] of groups) {
          const redundant = g.totalSelf * ((g.count - 1) / g.count);
          const {comparable, generic} = countComparableParts(sig);
          if (comparable === 0) {
            shapeOnlyBytes += redundant;
            shapeOnlyGroups++;
          } else if (generic > 0) {
            // Some properties compared, some could not be. The members agree
            // on what was readable and may differ on everything else, so this
            // is an upper bound and not a win until a sample is read.
            partialBytes += redundant;
            partialGroups++;
          } else {
            totalReclaimable += redundant;
          }
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
        const shown = ranked.slice(0, limit).map(g => {
          const {comparable, generic} = countComparableParts(g.sig);
          // Only for the handful of groups actually printed: re-read the
          // excluded identity props on up to three members. Disagreement
          // proves the group is not duplicates, which is cheap to establish
          // and expensive to get wrong.
          const identities = new Set<string>();
          for (const id of g.sampleIds) {
            const n = snapshot.getNodeById(id);
            if (!n) continue;
            const ident = readIgnoredIdentity(n, ignoreProps);
            if (ident != null) identities.add(ident);
          }
          const base =
            comparable === 0
              ? 'shape only'
              : generic > 0
                ? 'partial'
                : 'content';
          // The disproof applies to `shape only` and `partial` ONLY. Excluding
          // identity properties is the documented point of the signature — it
          // is what lets normalized store records that differ only by data-id
          // collapse together — so differing ids do not disprove a group whose
          // every comparable property agreed. They do disprove one where the
          // agreement was a generic `=o`/`=n` marker, which is evidence of
          // nothing on its own. Keeping `content` here is also what makes the
          // headline CONFIRMED total reconcile with the table: that total is
          // summed over every `content` group without the re-read, so
          // relabelling some of them below contradicted it.
          const verdict =
            base !== 'content' && identities.size > 1 ? 'NOT duplicates' : base;
          return {...g, comparable, generic, verdict};
        });

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
          `**${formatNumber(scopeCount)}** instances in scope collapse to **${formatNumber(distinct)}** signature groups ` +
            `(ratio **${(scopeCount / Math.max(1, distinct)).toFixed(1)}×**) of ${formatBytes(scopeSelf)} total self size.`,
          '',
          `- **CONFIRMED duplicate content** (every property was comparable): **~${formatBytes(totalReclaimable)}**`,
          `- PARTIAL (some properties could not be compared — an upper bound, verify a sample before quoting): ` +
            `~${formatBytes(partialBytes)} across ${formatNumber(partialGroups)} group(s)`,
          `- SHAPE ONLY (every property is a generic \`=o\`/\`=n\` marker — **not a win, do not quote**): ` +
            `~${formatBytes(shapeOnlyBytes)} across ${formatNumber(shapeOnlyGroups)} group(s)`,
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

        // AFTER the no-rows early return: the three totals above are over
        // EVERY group while the table is `ranked`, which also applies
        // min_count / min_dup_ratio / limit. Said only when those actually
        // hide something, and only when there IS a table to say it about —
        // "the table below shows 0 of N" printed above a "no groups found"
        // message describes a table that was never rendered.
        // Gated on how many groups are actually PRINTED, not on how many pass
        // the filters: `limit` hides rows exactly as `min_count` does, so 20
        // passing groups shown 10 at a time is the same reconciliation gap.
        if (shown.length < groups.size) {
          lines.push(
            `_Totals are over all ${formatNumber(groups.size)} groups. The table below shows ` +
              `${formatNumber(shown.length)} of ${formatNumber(ranked.length)} that pass ` +
              `\`min_count\`${min_dup_ratio != null ? ' / `min_dup_ratio`' : ''}` +
              `${ranked.length > shown.length ? ' (capped by `limit`)' : ''}` +
              ', so the rows do not sum to the figures above._',
            '',
          );
        }

        const headers = [
          'Count',
          'Self each',
          'Redundant bytes',
          'Verdict',
          'Values compared',
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
            g.verdict,
            `${g.comparable} of ${g.comparable + g.generic}`,
            `@${g.exampleId}`,
            sigShown,
          ];
        });
        lines.push(markdownTable(headers, rows, rightCols));
        lines.push(
          '',
          '_**Verdict** — `content`: EVERY property was comparable, so the members really do carry identical content. ' +
            '`partial`: some properties compared, some are generic `=o`/`=n` — an upper bound only; read two members before quoting it. ' +
            '`shape only`: every property is a generic `=o` (any object) or `=n` (any number) marker, so the group proves the members share a SHAPE and says nothing about their contents — **the redundant-bytes figure is not a win**. ' +
            '`NOT duplicates`: a `shape only` / `partial` group whose sampled members ALSO disagree on an excluded identity property (e.g. `id`) — shape agreement plus differing ids is not evidence of duplication. A `content` group is never relabelled this way: excluding identity properties is what lets normalized records that differ only by data-id collapse, which is the point of the tool. ' +
            'Only `content` rows are counted in the CONFIRMED total above._',
        );

        if (!suggestionsSuppressed('memlab_duplicate_objects')) {
          lines.push(
            '',
            '**Suggested next steps:**',
            `- **Disprove it first**: \`memlab_object_shape(${shown[0].exampleId})\` on two members of the same group and compare the property VALUES. A \`shape only\` verdict means the signature could not do this for you.`,
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
