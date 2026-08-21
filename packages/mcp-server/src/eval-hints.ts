/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * Recognise an eval that is re-implementing a tool that already exists, and say
 * so alongside the result.
 *
 * The discoverability problem this addresses is measured, not hypothetical: in
 * one long session `memlab_eval_across`, `memlab_population_diff`,
 * `memlab_event_registry`, `memlab_collection_trend` and `memlab_verify_fix`
 * all existed, all would have saved work, and none was called — while the same
 * questions were answered with hand-written evals, several times each. The
 * operator had even read the warning about exactly this and still did not open
 * the catalogue, because under time pressure writing the eval is the shorter
 * path and nothing in that path mentions the alternative.
 *
 * So the hint is attached to the RESULT of the call that made the mistake,
 * which is the one moment the caller is guaranteed to read. Two rules keep it
 * from becoming noise:
 *
 *  - **Never suppress or alter the result.** The eval ran; the hint is a
 *    footnote. A hint that blocked or replaced output would be worse than the
 *    duplication it is trying to prevent.
 *  - **Match on structure, not vocabulary.** A pattern fires only when the code
 *    shows the SHAPE of the built-in's job (a `{callback, context}` census, a
 *    per-class count keyed by snapshot, a detached-node distribution), not
 *    merely because it mentions a word.
 */

export interface EvalHint {
  tool: string;
  why: string;
}

interface HintRule {
  tool: string;
  why: string;
  /** Every regex must match for the rule to fire. */
  all: RegExp[];
  /** If any of these match, the rule is suppressed. */
  none?: RegExp[];
}

const RULES: HintRule[] = [
  {
    tool: 'memlab_event_registry',
    why: 'counts `{callback, context}` listener records by event and host directly',
    // `callback` and `context` are two of the most common identifiers in
    // JavaScript, so matching them alone fires on evals that have nothing to do
    // with listeners. Require the SHAPE as well: both read as properties off
    // the same record, and the eval is accumulating or iterating over them.
    all: [
      /[.[]['"]?callback\b|\bcallback\s*:/,
      /[.[]['"]?context\b|\bcontext\s*:/,
      /&&|\+\+|\+= ?1|\|\| ?0\) ?\+ ?1|\?\? ?0\) ?\+ ?1|\.push\(|\bfor\b/,
    ],
    // Already going through the census tool, or bucketing something else.
    none: [/memlab_event_registry/],
  },
  {
    tool: 'memlab_detached_dom',
    why: 'reports the detached-node population and its per-class distribution, using the same pinned/GC-eligible split the other tools use',
    all: [/is_detached|isRealDetached|Detached </],
    none: [/memlab_detached_dom/],
  },
  {
    tool: 'memlab_census_diff',
    why: 'takes the detached and listener census on BOTH rungs and diffs them per class in one call — no manual map-building or unload/reload cycle',
    all: [
      /is_detached|isRealDetached|Detached </,
      /\bbaseline\b|\bbefore\b|\bprev\b/,
    ],
    none: [/memlab_census_diff/],
  },
  {
    tool: 'memlab_class_histogram',
    why: 'produces the per-class count/size table without a hand-written walk',
    // Deliberately not keyed to the identifier `node`: the callback parameter
    // is as often `n`, and requiring the long spelling made the rule silently
    // never fire on the shape it exists to catch.
    all: [
      /snapshot\.nodes\.forEach|for\s*\(\s*const\s+\w+\s+of\s+snapshot\.nodes/,
      /\.name\b/,
      /\+\+|\+= ?1|\|\| ?0\) ?\+ ?1|\?\? ?0\) ?\+ ?1/,
    ],
    none: [/memlab_class_histogram|helpers\.classCounts/],
  },
  {
    tool: 'memlab_ladder_probe',
    why: 'runs ONE numeric probe across an ordered ladder and returns the series, the per-cycle rate and r² — loading one rung at a time, so it works on captures too large to hold simultaneously',
    all: [/helpers\.(save|load)\(|__rung|perRung|per_rung/],
    none: [/memlab_ladder_probe/],
  },
  {
    tool: 'memlab_duplicate_objects',
    why: 'is a ready-made dedup report over object content signatures',
    all: [/shapeSignature|objectContentSignature/, /\bMap\b|\bSet\b/],
    none: [/memlab_duplicate_objects/],
  },
  {
    // One canonical tool name per hint. The pair used to be crammed into this
    // single field, which rendered as one backticked identifier containing a
    // slash and spaces — not a name any caller or renderer can resolve. The
    // sibling tool goes in `why`, as prose, where it belongs.
    tool: 'memlab_map_entries',
    why: 'enumerates collection entries without the backing-store walk (see `memlab_weakmap_entries` for WeakMaps)',
    all: [/table|backing/i, /\bMap\b|\bWeakMap\b/],
    none: [
      /helpers\.mapEntries|helpers\.weakmapEntries/,
      /memlab_map_entries|memlab_weakmap_entries/,
    ],
  },
  {
    tool: 'memlab_retainer_trace',
    why: 'walks retainer paths with framework filtering and path collapsing already applied',
    all: [
      /\.referrers\b/,
      /while\s*\(|for\s*\(/,
      /pathEdge|dominatorNode|\.referrers\[0\]/,
    ],
    none: [/memlab_retainer_trace|helpers\.pathBetween/],
  },
];

/**
 * At most this many hints per call. Beyond two the footnote stops being a
 * pointer and starts being a second result the caller has to read.
 */
const MAX_HINTS = 2;

export function hintsForEval(code: string): EvalHint[] {
  const hints: EvalHint[] = [];
  for (const rule of RULES) {
    if (hints.length >= MAX_HINTS) break;
    if (rule.none?.some(re => re.test(code))) continue;
    if (!rule.all.every(re => re.test(code))) continue;
    hints.push({tool: rule.tool, why: rule.why});
  }
  return hints;
}

export function formatEvalHints(hints: EvalHint[]): string | null {
  if (hints.length === 0) return null;
  return hints
    .map(h => `note: \`${h.tool}\` does this directly — it ${h.why}.`)
    .join('\n');
}
