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
import type {IHeapEdge, IHeapNode} from '@memlab/core';
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

// The canonical parse-boundary intern fix caps at 128 chars (the skill's
// recommended cap: interning very long, low-cardinality strings costs a large
// unique-set retention for little collapse). So the "within-load capturable"
// figure double-counts value that a COMPLIANT fix would skip. Splitting savings
// at this length lets the headline report cappable (what the 128-char fix
// reclaims) separately from over-cap (needs an uncapped pool or a different fix)
// so the reported number matches what the recommended fix actually reclaims
// (sweep feedback §3).
const CANONICAL_CAP_CHARS = 128;

/**
 * Label the array (and, one level up, its owner) that holds a duplicated
 * array-element string, so columnar / rows-as-arrays duplication groups by a
 * meaningful owner shape (e.g. `Query._rows[]`, `Array[][] (columnar rows)`)
 * instead of a bare `Object`. Walks a bounded set of referrers with the
 * non-materializing iterator (never the O(N) `.referrers` getter).
 */
function arrayOwnerLabel(arrayNode: IHeapNode): string {
  const refs: IHeapEdge[] = [];
  arrayNode.forEachReferrer(ref => {
    refs.push(ref);
    if (refs.length >= 8) return {stop: true};
  });
  for (const ref of refs) {
    const fromName = ref.fromNode.name || '';
    if (ref.type === 'property' || ref.type === 'context') {
      const owner = fromName && fromName !== 'Object' ? fromName : 'Object';
      return `${owner}.${String(ref.name_or_index)}[]`;
    }
    if (ref.type === 'element') {
      // An array held as an element of another array = matrix / columnar rows.
      const owner = fromName && fromName !== 'Object' ? fromName : 'Array';
      return `${owner}[][] (columnar rows)`;
    }
    if (
      (ref.type === 'hidden' || ref.type === 'internal') &&
      fromName &&
      fromName !== 'Object'
    ) {
      return `${fromName}[]`;
    }
  }
  return arrayNode.name && arrayNode.name !== 'Object'
    ? `${arrayNode.name}[]`
    : 'Array[]';
}

interface InternGroup {
  propertyName: string;
  parentShape: string;
  parentShapeProps: string[];
  uniqueStrings: number;
  totalCopies: number;
  totalSize: number;
  savingsIfInterned: number;
  // savingsIfInterned split by string length at the canonical 128-char cap:
  // `savingsCappable` is what the recommended ≤128-char intern pool reclaims;
  // `savingsOverCap` is held in longer strings the cap skips (sweep feedback §3).
  savingsCappable: number;
  savingsOverCap: number;
  topStrings: Array<{value: string; count: number; size: number}>;
  exampleParentId: number;
  // True when the duplicated strings are held as ARRAY ELEMENTS (columnar /
  // rows-as-arrays — e.g. a mysql2/Drizzle rowsAsArray result buffer) rather than
  // named object properties. Grouped by column index × array-owner shape and
  // folded into the within-load headline, since interning at the array-
  // construction (parse) site collapses them (sweep feedback §2).
  arrayElement?: boolean;
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
  // True when the group is high-cardinality with few repeats (copies ÷ unique
  // below ~3) AND its strings are long on average (> ~128 bytes): a per-load
  // intern pool would have to retain a large unique set for a small collapse, so
  // the reported "savings" overstate the real win and the field should usually
  // be skipped. Bucketed OUT of the within-load headline (Feedback round 7 §1).
  lowRoi?: boolean;
  // True when the holding property/shape is framework- or infra-owned (HTTP
  // request headers, cookies, auth tokens, Next.js URL/cache context) rather
  // than application data — out of scope for an app-level parse-boundary intern
  // pool, so bucketed OUT of the within-load headline (Feedback round 7 §2).
  frameworkOwned?: boolean;
}

// --- Headline-accuracy heuristics (Feedback round 7) ----------------------
// Both operate purely on a group's already-aggregated counts / extracted shape
// props — no heap traversal — so they are O(groups), not O(nodes).

// Low-ROI: strings barely repeat (copies ÷ unique below the floor) AND are long
// on average. Interning needs a pool holding the whole unique set for a small
// collapse — high memory cost, low payoff (e.g. a ~141-char value at 2.2×).
const LOW_ROI_DUP_FLOOR = 3;
const LOW_ROI_AVG_BYTES = 128;
function isLowRoiGroup(
  uniqueStrings: number,
  totalCopies: number,
  totalSize: number,
): boolean {
  if (uniqueStrings <= 0 || totalCopies <= 0) return false;
  const dupFactor = totalCopies / uniqueStrings;
  const avgBytes = totalSize / totalCopies;
  return dupFactor < LOW_ROI_DUP_FLOOR && avgBytes > LOW_ROI_AVG_BYTES;
}

// Report a `(concatenated string)` (rope) buildup — string accumulation, not
// value duplication, which interning cannot help — once this many such nodes are
// present. Shared by the empty-results path and the main results header so the
// two call sites cannot drift out of sync.
const CONCAT_STRING_BUILDUP_FLOOR = 1_000_000;

// Framework/infra-owned: request headers, cookies, auth tokens, and Next.js
// URL/cache context. Matched by property name and by tell-tale property names in
// the parent shape.
// NOTE: deliberately excludes the generic single-word `via` — though HTTP `Via`
// is a real header, `via` is a plausible application property name and an exact
// match would misclassify app data as framework-owned. Real `Via` headers are
// still caught by the `x-`/`sec-` prefixes and the parent-shape header-bag check.
// The `.+_oauth_token` / `.+-access-token` alternatives intentionally match any
// non-empty prefix: a property name ending in those suffixes is auth-token data
// regardless of prefix. `.+` (not `.*`) keeps bare `_oauth_token` /
// `-access-token` from matching.
const FRAMEWORK_PROP_RE =
  /^(cookie|set-cookie|user-agent|accept-language|accept-encoding|referer|referrer|x-[a-z0-9-]+|sec-[a-z0-9-]+|proxied_to_master|.+_oauth_token|.+-access-token)$/i;
const FRAMEWORK_SHAPE_NAME_RE = /^(URLContext|IncomingMessage|ServerResponse)$/;
const FRAMEWORK_SHAPE_PROPS = new Set([
  'cookie',
  'user-agent',
  'accept-language',
  'x-fb-validated-client-cert',
  'proxied_to_master',
  'intern_oauth_token',
]);
function isFrameworkOwned(
  propertyName: string,
  parentShape: string,
  parentShapeProps: string[],
): boolean {
  if (FRAMEWORK_PROP_RE.test(propertyName)) return true;
  if (FRAMEWORK_SHAPE_NAME_RE.test(parentShape)) return true;
  // Next.js incremental-cache / route context shape.
  if (
    parentShapeProps.includes('defaultLocale') &&
    parentShapeProps.includes('incrementalCache')
  ) {
    return true;
  }
  // A request-header bag: two or more header-ish props in the same shape.
  // Deliberately heuristic, with two accepted trade-offs (kept conservative
  // rather than tightened, since tuning needs real heap data):
  //  • False negative: `parentShapeProps` is the upstream sample, capped at 12
  //    entries and pre-sorted alphabetically, so an anonymous header bag whose
  //    12 alphabetically-first props are not header-ish slips through. The
  //    common named shapes are still caught by FRAMEWORK_SHAPE_NAME_RE above.
  //  • False positive: an app object that genuinely models ≥2 of these
  //    HTTP-specific names (e.g. `cookie` + `user-agent`) is misclassified. The
  //    names are HTTP-specific enough that this is rare; `>= 2` (not `>= 1`)
  //    guards the most likely single-field collisions.
  let headerish = 0;
  for (const p of parentShapeProps) {
    if (FRAMEWORK_SHAPE_PROPS.has(p)) headerish++;
  }
  return headerish >= 2;
}

export function registerInternOpportunities(server: McpServer): void {
  server.tool(
    'memlab_intern_opportunities',
    'Identify string interning opportunities by grouping duplicated strings by the property name and parent object shape that holds them. Shows total savings per (property × shape) combination — the key metric for deciding where to add a string interning pool. Also surfaces ARRAY-ELEMENT / columnar duplication (strings held as elements of a rowsAsArray / string[][] result buffer — a common Nest mysql2/Drizzle shape) as first-class groups keyed by column index and array-owner shape, folded into the within-load headline; these are marked with a filled square and fixed by interning at the array-construction/parse site. The within-load figure is split at the canonical 128-char intern cap into cappable (<=128 chars, what the recommended fix reclaims) vs over-cap (longer strings the cap skips), so the headline matches what a compliant fix actually reclaims. Replaces the manual workflow of: duplicated_strings → retainer_summary → codebase grep. ' +
      'Retention-aware: flags groups whose duplicated instances are ALSO held by another structure (e.g. a raw array/matrix) as "co-retained" — interning the property there reclaims ~0, so the savings are reported separately and you must dedupe the shared source instead. ' +
      'The headline "within-load capturable" figure also excludes framework/infra-owned strings (HTTP headers, cookies, auth tokens, Next.js URL/cache context) and low-ROI groups (high-cardinality + long strings, where the intern pool costs more than it saves), reporting each in its own bucket; and it flags concatenated-string (rope) buildup, which is accumulation rather than duplication and cannot be interned. ' +
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

        // Cheap retention-pattern signal (Feedback round 7 §4): a heap dominated
        // by `(concatenated string)` (cons/rope) nodes is string ACCUMULATION
        // (repeated `+=` / join into a long-lived buffer), NOT value duplication
        // — interning cannot help. Count them by name in the pass we already do
        // (O(1) per node, no value materialization) so we can flag the pattern
        // instead of silently reporting tiny interning wins.
        let concatStringCount = 0;
        let concatStringSize = 0;

        snapshot.nodes.forEach(node => {
          if (node.name === '(concatenated string)') {
            concatStringCount++;
            concatStringSize += node.self_size;
          }
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
            arrayElement: boolean;
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
              arrayElement: boolean;
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
            // If there is none, fall back to an array-element referrer so strings
            // held as ARRAY ELEMENTS (columnar / rows-as-arrays — a very common
            // Nest shape: mysql2/Drizzle rowsAsArray SELECT buffers) become a
            // first-class group instead of being silently dropped. Previously the
            // biggest single win of a sweep could hide because it was columnar
            // (sweep feedback §2).
            let primary: IHeapEdge | null = null;
            for (const ref of refs) {
              if (ref.type === 'property' || ref.type === 'context') {
                primary = ref;
                break;
              }
            }
            let isArrayElement = false;
            if (!primary) {
              for (const ref of refs) {
                if (ref.type === 'element') {
                  primary = ref;
                  isArrayElement = true;
                  break;
                }
              }
            }
            if (!primary) continue;
            const parent = primary.fromNode;
            // For array elements, key the "property" by the column index so a
            // fixed column across rows groups together (e.g. `[3]`); named props
            // key by their name as before.
            const propName = isArrayElement
              ? `[${String(primary.name_or_index)}]`
              : String(primary.name_or_index);

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
            let shapeKey: string;
            if (isArrayElement) {
              // Arrays carry element edges, not a property shape — label by the
              // array's owner (one level up) so columnar rows group by owner.
              shapeKey = arrayOwnerLabel(parent);
            } else {
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
              shapeKey =
                parent.name !== 'Object'
                  ? parent.name
                  : parentProps.length > 0
                    ? `{${parentProps.join(',')}}`
                    : 'Object';
            }

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
                arrayElement: isArrayElement,
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
              // OR the flag across samples rather than trusting the first: if a
              // key is ever reached from both an element and a non-element
              // referrer (e.g. a property literally named `[N]`), the group is
              // still treated as columnar so the label/marker/totals stay
              // consistent.
              existing.arrayElement =
                existing.arrayElement || dist.arrayElement;
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
                arrayElement: dist.arrayElement,
              });
            }
          }
        }

        // Step 3: Compute savings and filter
        const groups: InternGroup[] = [];
        for (const g of groupMap.values()) {
          if (g.totalCopies < min_copies) continue;

          let savingsIfInterned = 0;
          let savingsCappable = 0;
          let savingsOverCap = 0;
          const topStrings: Array<{
            value: string;
            count: number;
            size: number;
          }> = [];

          for (const [value, strStats] of g.strings) {
            if (strStats.count > 1) {
              const perCopy = strStats.size / strStats.count;
              const s = (strStats.count - 1) * perCopy;
              savingsIfInterned += s;
              // A ≤128-char value is what the canonical intern fix would cap and
              // reclaim; longer values are skipped by that cap (feedback §3).
              if (value.length <= CANONICAL_CAP_CHARS) savingsCappable += s;
              else savingsOverCap += s;
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
            savingsCappable,
            savingsOverCap,
            topStrings: topStrings.slice(0, 3),
            exampleParentId: g.exampleParentId,
            arrayElement: g.arrayElement,
            coRetained,
            coRetainedVia: coRetained ? g.coRetainedVia : undefined,
            lowRoi: isLowRoiGroup(g.strings.size, g.totalCopies, g.totalSize),
            frameworkOwned: isFrameworkOwned(
              g.propertyName,
              g.parentShapeKey,
              g.parentShapeProps,
            ),
          });
        }

        groups.sort((a, b) => b.savingsIfInterned - a.savingsIfInterned);
        const shown = groups.slice(0, limit);

        if (shown.length === 0) {
          // The property×shape grouping above only sees strings held as named
          // OBJECT PROPERTIES. Strings held as ARRAY ELEMENTS (columnar /
          // rows-as-arrays — e.g. a DB driver's string[][] result buffer) never
          // form a property group, so a heap can show millions of duplicated
          // cells yet report zero opportunities here. Cross-check the already-
          // built stringMap (in-memory Map iteration — no extra heap traversal)
          // and surface the heaviest duplicates so the user isn't dead-ended.
          const arrayDupes: Array<{
            value: string;
            count: number;
            savings: number;
          }> = [];
          for (const [value, s] of stringMap) {
            if (s.count < min_copies) continue;
            const savings = (s.totalSize * (s.count - 1)) / s.count;
            if (savings < min_savings) continue;
            arrayDupes.push({value, count: s.count, savings});
          }
          arrayDupes.sort((a, b) => b.savings - a.savings);

          let msg = `No significant interning opportunities found (min ${formatNumber(min_copies)} copies, min ${formatBytes(min_savings)} savings). Try lowering thresholds. If the heap is instead dominated by a few large strings/objects (not many small duplicates), interning won't help — use memlab_largest_objects or memlab_sliced_strings to investigate blob retention.`;
          if (concatStringCount > CONCAT_STRING_BUILDUP_FLOOR) {
            msg += `\n\n⚠ Concatenated-string buildup: ${formatNumber(concatStringCount)} \`(concatenated string)\` nodes (~${formatBytes(concatStringSize)} self-size). This is string ACCUMULATION (repeated \`+=\` / join into a long-lived buffer), NOT value duplication — interning cannot help. Investigate with memlab_largest_objects / memlab_sliced_strings and trace the retaining structure.`;
          }
          if (arrayDupes.length > 0) {
            const totalDup = arrayDupes.reduce((a, d) => a + d.savings, 0);
            const top = arrayDupes
              .slice(0, 5)
              .map(
                d =>
                  `  • ${JSON.stringify(
                    d.value.length > 40 ? d.value.slice(0, 40) + '…' : d.value,
                  )} ×${formatNumber(d.count)} (~${formatBytes(d.savings)})`,
              )
              .join('\n');
            msg += `\n\n⚠ However, ${formatNumber(
              arrayDupes.length,
            )} value(s) are heavily duplicated (~${formatBytes(
              totalDup,
            )} total) but were NOT surfaced as property groups above. This is expected when they are held as ARRAY ELEMENTS / columnar rows (e.g. a string[][] query-result buffer) rather than object properties — but it can also happen when their property groups fell below the min_copies / min_savings thresholds. If they are array elements, interning at the array-construction (parse) site collapses them; if they are properties, lower the thresholds to surface the group. Top:\n${top}\nUse memlab_search_strings to locate where each is built and confirm how it is held.`;
          }
          return toolResult(msg);
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

        // Split savings into mutually-exclusive buckets (Feedback round 4 §1 —
        // retention-aware — extended in round 7):
        //  • co-retained — the duplicated instances are ALSO held by another
        //    structure, so interning the property reclaims ~0; the shared
        //    source must be deduped/dropped. Reported separately so the figure
        //    is not mistaken for an easy per-property win.
        //  • within-load — capturable by a per-load/per-request intern pool.
        //  • cross-load — needs a shared/module-scope pool (Feedback round 3 §1c).
        //  • framework — header/cookie/token/Next.js-context strings; not app
        //    data, so an app-level intern pool should not target them
        //    (Feedback round 7 §2).
        //  • low-ROI — high-cardinality + long strings whose pool cost dwarfs the
        //    collapse; usually skip (Feedback round 7 §1).
        // Each group lands in exactly one bucket (precedence below) so the
        // headline within-load figure reflects only realistic app-data wins.
        // Framework/infra-owned is checked FIRST: "this is not application data"
        // is the most fundamental classification and the most actionable label
        // for the reader (skip it — it isn't yours), so a framework string is
        // always surfaced as framework even when it is ALSO co-retained or
        // duplicated across loads — HTTP request headers are duplicated across
        // requests by nature, so a header would otherwise be miscounted as
        // cross-load and the framework bucket under-counted. The remaining order
        // is retention-then-ROI; every non-`within` bucket is excluded from the
        // within-load headline regardless of which one a group lands in.
        const bucketOf = (
          g: InternGroup,
        ): 'framework' | 'coRetained' | 'crossLoad' | 'lowRoi' | 'within' => {
          if (g.frameworkOwned) return 'framework';
          if (g.coRetained) return 'coRetained';
          if (g.crossLoad) return 'crossLoad';
          if (g.lowRoi) return 'lowRoi';
          return 'within';
        };
        const sumBucket = (bucket: string): number =>
          shown
            .filter(g => bucketOf(g) === bucket)
            .reduce((sum, g) => sum + g.savingsIfInterned, 0);
        const coRetainedSavings = sumBucket('coRetained');
        const crossLoadSavings = sumBucket('crossLoad');
        const frameworkSavings = sumBucket('framework');
        const lowRoiSavings = sumBucket('lowRoi');
        const withinLoadSavings = sumBucket('within');

        // Within the capturable bucket, split by the canonical 128-char cap so the
        // headline reports what a COMPLIANT fix reclaims, not the raw total that
        // includes over-cap strings the fix skips (feedback §3). Also surface how
        // much of the capturable win is columnar / array-element duplication so it
        // is no longer buried (feedback §2).
        const withinGroups = shown.filter(g => bucketOf(g) === 'within');
        const withinCappable = withinGroups.reduce(
          (s, g) => s + g.savingsCappable,
          0,
        );
        const withinOverCap = withinGroups.reduce(
          (s, g) => s + g.savingsOverCap,
          0,
        );
        // Use the cappable portion (not the full savings) so this figure always
        // fits inside the withinCappable headline — otherwise a columnar group
        // with long strings could report "includes N of columnar" where N
        // exceeds the leading cappable number, which reads as a contradiction.
        const withinArrayElementCappable = withinGroups
          .filter(g => g.arrayElement)
          .reduce((s, g) => s + g.savingsCappable, 0);
        const totalSavings =
          withinLoadSavings +
          crossLoadSavings +
          coRetainedSavings +
          frameworkSavings +
          lowRoiSavings;
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
          'Avg len',
          'Total Size',
          'Savings',
          '% Heap',
          'Example Parent',
        ];
        const rightCols = new Set([2, 3, 4, 5, 6, 7, 8]);
        const rows = shown.map(g => {
          const shape =
            g.parentShape.length > 40
              ? g.parentShape.slice(0, 37) + '…}'
              : g.parentShape;
          const pct =
            totalSize > 0
              ? ((g.savingsIfInterned / totalSize) * 100).toFixed(1) + '%'
              : '-';
          const avgLen =
            g.totalCopies > 0
              ? formatBytes(Math.round(g.totalSize / g.totalCopies))
              : '-';
          // Array-element groups already read as `[3]`; a leading dot would
          // produce a malformed label, so only prefix `.` for named properties.
          const label = g.arrayElement ? g.propertyName : `.${g.propertyName}`;
          return [
            `${label}${g.arrayElement ? ' ▦' : ''}${g.coRetained ? ' ⚠' : ''}${g.crossLoad ? ' ⤫' : ''}${g.frameworkOwned ? ' ▤' : ''}${g.lowRoi ? ' ▽' : ''}`,
            shape,
            formatNumber(g.uniqueStrings),
            formatNumber(g.totalCopies),
            fmtDup(g.totalCopies, g.uniqueStrings),
            avgLen,
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
        // Measure cross-load duplication from the raw `crossLoad` flag, NOT the
        // post-precedence bucket. Framework-owned strings are reclassified out of
        // the `crossLoad` bucket, but a stale+fresh double-buffer of e.g. HTTP
        // headers is a real retention/concurrency bug regardless of who owns the
        // data — and the verdict for it is explicitly "NOT interning". Gating on
        // the bucket sum would let the detector silently stop firing once 2×
        // framework groups leave the `crossLoad` bucket.
        const crossLoadDupSavings = shown
          .filter(g => g.crossLoad && !g.coRetained)
          .reduce((sum, g) => sum + g.savingsIfInterned, 0);
        const twoXCrossLoadSavings = shown
          .filter(g => g.crossLoad && !g.coRetained && isExactlyTwoX(g))
          .reduce((sum, g) => sum + g.savingsIfInterned, 0);
        const retentionBugSuspected =
          crossLoadDupSavings > 0 &&
          crossLoadDupSavings >= withinLoadSavings &&
          crossLoadDupSavings >= coRetainedSavings &&
          twoXCrossLoadSavings >= crossLoadDupSavings * 0.5;

        // One-line verdict (Feedback round 5 §9): which bucket dominates decides
        // the fix shape, so lead with it before the detail. A suspected
        // retention/concurrency bug is checked FIRST — it is a real memory bug
        // (NOT an interning win) and is framework-independent, so it must surface
        // even when the 2× duplication is framework-owned and bucketed out of
        // `crossLoad`.
        // Every "mostly <bucket>" branch gates on the bucket being ≥ ALL other
        // buckets (including framework/low-ROI), so the headline always names the
        // bucket that actually dominates the heap. Without the framework/low-ROI
        // comparison the cascade is asymmetric: a second-largest co-retained or
        // cross-load bucket would be reported as the headline even when
        // framework/low-ROI dominate (e.g. framework=100MB, crossLoad=10MB). The
        // retention-bug branch is exempt — it is a correctness flag, not a
        // "biggest bucket" claim, so it leads regardless of magnitude.
        let verdict: string;
        if (retentionBugSuspected) {
          verdict = `Verdict: ⚠ likely **retention/concurrency bug** (NOT interning) — ${formatBytes(twoXCrossLoadSavings)} of cross-load duplication at ~2.0× (copies ÷ unique), i.e. two copies of the same dataset held at once (stale+fresh double-buffer / setInterval). A per-request intern pool will NOT help; fix the double retention at the source.`;
        } else if (
          coRetainedSavings >= withinLoadSavings &&
          coRetainedSavings >= crossLoadSavings &&
          coRetainedSavings >= frameworkSavings &&
          coRetainedSavings >= lowRoiSavings &&
          coRetainedSavings > 0
        ) {
          verdict = `Verdict: mostly **co-retained** (${formatBytes(coRetainedSavings)}) — interning the property won't help; dedupe at the shared source.`;
        } else if (
          crossLoadSavings >= withinLoadSavings &&
          crossLoadSavings >= frameworkSavings &&
          crossLoadSavings >= lowRoiSavings &&
          crossLoadSavings > 0
        ) {
          verdict = `Verdict: mostly **cross-load** (${formatBytes(crossLoadSavings)}) — a per-request pool won't collapse it; needs a shared/module-scope pool or a retention fix.`;
        } else if (
          withinLoadSavings > 0 &&
          withinLoadSavings >= frameworkSavings &&
          withinLoadSavings >= lowRoiSavings
        ) {
          // Lead with the ≤128-char cappable figure — the amount the canonical
          // intern fix actually reclaims — not the raw within-load total that also
          // counts over-cap strings the fix skips (feedback §3).
          const capNote =
            withinOverCap > 0
              ? ` (+${formatBytes(withinOverCap)} in >${CANONICAL_CAP_CHARS}-char strings the 128-char cap skips — needs an uncapped pool or a different fix)`
              : '';
          const columnarNote =
            withinArrayElementCappable > 0
              ? ` Includes ${formatBytes(withinArrayElementCappable)} of columnar / array-element (rowsAsArray) duplication — intern at the array-construction/parse site.`
              : '';
          verdict = `Verdict: **${formatBytes(withinCappable)} cappable** by the canonical ≤${CANONICAL_CAP_CHARS}-char per-load/per-request intern pool at the parse boundary${capNote}.${columnarNote}`;
        } else if (frameworkSavings + lowRoiSavings > 0) {
          // Framework/low-ROI dominate (each ≥ the within-load figure). Lead with
          // them so a small capturable remainder isn't mistaken for the headline,
          // but still name that remainder when nonzero so it isn't hidden.
          const parts: string[] = [];
          if (frameworkSavings > 0) {
            parts.push('framework/infra-owned (headers/cookies/tokens)');
          }
          if (lowRoiSavings > 0) {
            parts.push('low-ROI (high-cardinality, long strings)');
          }
          const remainder =
            withinLoadSavings > 0
              ? ` (only ${formatBytes(withinLoadSavings)} is app-capturable by a per-load pool)`
              : '';
          verdict = `Verdict: largely no app-actionable interning${remainder} — the bulk is ${parts.join(' and ')}, which a per-load app intern pool should not target.`;
        } else {
          verdict =
            'Verdict: no clearly-capturable interning savings — if the heap is dominated by a few large strings/objects, use memlab_largest_objects or memlab_sliced_strings to investigate blob retention.';
        }

        const headerLines: string[] = [
          `# String Interning Opportunities`,
          '',
          verdict,
          '',
          `**Total duplication across top ${shown.length} groups: ${formatBytes(totalSavings)}${pctOfHeap}**`,
          `- **Within-load (capturable by a per-load/per-request intern pool): ${formatBytes(withinLoadSavings)}${pctOf(withinLoadSavings)}**`,
        ];
        // Split the within-load figure at the canonical 128-char cap so the
        // reported number matches what the recommended fix actually reclaims
        // (feedback §3). Only shown when there's over-cap value to distinguish —
        // otherwise the whole within-load figure is already cappable.
        if (withinOverCap > 0) {
          headerLines.push(
            `  - ≤${CANONICAL_CAP_CHARS}-char cappable (what the canonical 128-char intern fix reclaims): ${formatBytes(withinCappable)}`,
            `  - >${CANONICAL_CAP_CHARS}-char over-cap (skipped by the 128-char cap — needs an uncapped pool or a different fix): ${formatBytes(withinOverCap)}`,
          );
        }
        if (withinArrayElementCappable > 0) {
          headerLines.push(
            `  - ▦ of which columnar / array-element (rowsAsArray) duplication (cappable): ${formatBytes(withinArrayElementCappable)} — intern at the array-construction/parse site`,
          );
        }
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
        if (frameworkSavings > 0) {
          headerLines.push(
            `- **▤ Framework/infra-owned (HTTP headers, cookies, auth tokens, Next.js URL/cache context — not app data; out of scope for an app-level intern pool): ${formatBytes(frameworkSavings)}${pctOf(frameworkSavings)}**`,
          );
        }
        if (lowRoiSavings > 0) {
          headerLines.push(
            `- **▽ Low-ROI (high-cardinality, few repeats + long strings — a per-load pool retains a large unique set for a small collapse; usually skip): ${formatBytes(lowRoiSavings)}${pctOf(lowRoiSavings)}**`,
          );
        }
        if (concatStringCount > CONCAT_STRING_BUILDUP_FLOOR) {
          headerLines.push(
            '',
            `⚠ **Concatenated-string buildup:** ${formatNumber(concatStringCount)} \`(concatenated string)\` nodes (~${formatBytes(concatStringSize)} self-size) — a rope/accumulation pattern (repeated \`+=\` / join into a long-lived buffer), NOT value duplication. Interning cannot help; investigate with \`memlab_largest_objects\` / \`memlab_sliced_strings\` and trace the retainer.`,
          );
        }
        const coRetainedGroups = shown.filter(g => g.coRetained);
        const hasArrayElement = shown.some(g => g.arrayElement);
        const lines = [
          ...headerLines,
          '',
          markdownTable(headers, rows, rightCols),
          '',
        ];
        if (
          coRetainedGroups.length > 0 ||
          crossLoadSavings > 0 ||
          frameworkSavings > 0 ||
          lowRoiSavings > 0 ||
          hasArrayElement
        ) {
          lines.push(
            "▦ = array element (columnar / rowsAsArray — intern at the parse site); ⚠ = co-retained (interning won't reclaim); ⤫ = cross-load (high Dup ×, needs shared pool); ▤ = framework/infra-owned (not app data); ▽ = low-ROI (high-cardinality + long; usually skip).",
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
            // find_by_shape needs a property-shape fingerprint; array-element
            // (columnar) top groups have none (parentShapeProps is empty), so the
            // recipe would render an unactionable `properties []`. Emit it only for
            // a named-property top group — the columnar case is covered by the
            // array-element step below.
            ...(!shown[0].arrayElement && shown[0].parentShapeProps.length > 0
              ? [
                  `- Find all instances: \`memlab_find_by_shape\` with properties ${JSON.stringify(shown[0].parentShapeProps.slice(0, 5))}`,
                ]
              : []),
            '- Search codebase for the constructor/factory that creates these objects',
            ...(hasArrayElement
              ? [
                  '- For ▦ array-element (columnar / rowsAsArray) groups: the strings are cells of a result buffer, not object properties. Intern each cell where the rows are built (the DB driver’s rowsAsArray mapping or the parse loop) — e.g. `row[col] = intern(row[col])` per duplicated column — not at a property assignment site.',
                ]
              : []),
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
