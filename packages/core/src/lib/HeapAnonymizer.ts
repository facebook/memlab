/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @lightSyntaxTransform
 * @oncall memory_lab
 */

'use strict';

import type {HeapSnapshotMeta, IHeapSnapshot, RawHeapSnapshot} from './Types';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import stringLoader from './StringLoader';
import {serializeRawHeapSnapshot} from './HeapSerializer';

/**
 * Remove user data from a heap snapshot while leaving it analyzable.
 *
 * A heap snapshot is a verbatim dump of everything the page had in memory, so
 * it carries message bodies, tokens, contact ids and serialized DOM. Sharing
 * one — with a colleague, in a task, with a model — publishes all of it. The
 * goal here is a capture that can be shared and still answers the questions
 * snapshots are taken to answer.
 *
 * **What makes that possible is that the format separates values from labels.**
 * Every entry in the shared `strings` table is reached in one of two ways:
 *
 * - as the `name` of a `string` / `concatenated string` / `sliced string` node
 *   — that is the CONTENT of a JS string living on the heap, i.e. data;
 * - as an edge name, or the `name` of an object / closure / code / native node
 *   — that is a LABEL: a class name, a function name, a property key.
 *
 * A retainer trace is built entirely out of labels. So redacting exactly the
 * first kind is a type test, not a heuristic, and it leaves every trace,
 * histogram, dominator and shape analysis fully readable.
 *
 * Two things that clean split does NOT cover, both of which this module also
 * handles, because a real capture leaks through both:
 *
 * 1. **A label can itself be data.** An object keyed by account id, order id or
 *    session id turns user identifiers into property names — structurally a
 *    label, semantically a payload. No node-type test can tell `.addListener`
 *    from a key a database row supplied, so those are matched by shape against
 *    internet-standard formats. For identifier schemes private to one
 *    application, which no pattern list can anticipate, the report names what
 *    it could not classify and {@link AnonymizeOptions.shouldRedact} is the
 *    seam for acting on it.
 * 2. **`native` node names can hold serialized DOM.** Browser engines write
 *    element descriptions that on one measured capture reached 78 KB of
 *    `outerHTML`, base64-inlined images and user-visible text included.
 *
 * @internal
 */

/**
 * How redacted text is generated.
 *
 * - `stable` — length-preserving, and derived from the value, so equal inputs
 *   stay equal and distinct inputs stay distinct. Duplication, interning and
 *   dedup analyses therefore keep reporting the truth.
 * - `uniform` — length-preserving fill with a single repeated character. Leaks
 *   strictly less (not even equality), but it collapses every distinct value of
 *   the same length into one, which MANUFACTURES string duplication: on one
 *   measured capture 272,234 distinct values collapsed to 607, and duplication
 *   tools then reported tens of megabytes of savings that do not exist.
 */
export type AnonymizationMode = 'stable' | 'uniform';

/**
 * Options accepted by {@link anonymizeHeapSnapshot}.
 */
export type AnonymizeOptions = {
  /**
   * how replacement text is generated, defaults to `stable`
   * (see {@link AnonymizationMode})
   */
  mode?: AnonymizationMode;
  /**
   * salt mixed into `stable` replacements. The default is the empty string,
   * which is deterministic ACROSS FILES — the same value anonymizes to the
   * same token in every capture, so a ladder of snapshots stays diffable. That
   * also means a deterministic token is confirmable by anyone holding a
   * candidate value; pass an explicit salt for anything leaving your trust
   * boundary, and reuse that one salt across every file in the set.
   */
  salt?: string;
  /**
   * also redact node names that look like serialized DOM, defaults to `true`
   */
  redactDomText?: boolean;
  /**
   * also redact string table entries whose CONTENT looks like an identifier,
   * wherever they are referenced — including as property names, defaults to
   * `true`
   */
  redactIdentifierKeys?: boolean;
  /**
   * how many consecutive digits make a string an identifier rather than an
   * array index, defaults to `9`. Chosen from the data: V8 emits exhaustive
   * runs of short numeric index names (10 one-digit, 90 two-digit, 900
   * three-digit ... 138,432 six-digit on one capture) and then the count falls
   * off a cliff, so a floor in that gap separates indices from ids.
   */
  minDigitRunLength?: number;
  /** extra patterns to redact, matched against the string table entry */
  extraPatterns?: RegExp[];
  /** patterns that must NEVER be redacted; these win over every built-in rule */
  keepPatterns?: RegExp[];
  /**
   * the final say on any entry, consulted BEFORE every built-in rule.
   *
   * No fixed rule set can know an identifier scheme private to one application,
   * and guessing at one inside memlab would mean shipping other people's
   * formats to everybody. This is the seam for that instead: return `true` to
   * redact, `false` to protect, or `undefined` to let the built-in rules
   * decide. `AnonymizeReport.unclassifiedLabelFamilies` is the companion — it
   * names the shapes still in the clear, which is where a caller finds out what
   * their own scheme looks like.
   *
   * ```typescript
   * anonymizeHeapSnapshot(heap, {
   *   // this app keys caches by order id: ORD-<digits>
   *   shouldRedact: (value, ctx) =>
   *     ctx.isLabel && value.startsWith('ORD-') ? true : undefined,
   * });
   * ```
   */
  shouldRedact?: (
    value: string,
    context: RedactionContext,
  ) => boolean | undefined;
};

/**
 * A family of labels left in the clear that share one machine-generated shape.
 *
 * This is how the tool generalizes past its own pattern list. No fixed set of
 * formats can know an identifier scheme private to one application, so rather
 * than guess, the report names what it could not classify and lets the caller
 * decide. A family here is a prompt to look, not a finding: `d.d.d` is a
 * version number in one app and an account id in another.
 */
export type UnclassifiedLabelFamily = {
  /**
   * character-class shape with runs collapsed, e.g. `d@a` for `4155551234@ex`
   */
  shape: string;
  /** how many distinct labels in the string table share it */
  count: number;
  /** up to three of them, verbatim, so the shape can be recognized */
  examples: string[];
};

/**
 * What is known about one string table entry when {@link AnonymizeOptions.shouldRedact}
 * is asked to judge it.
 */
export type RedactionContext = {
  /**
   * true when this entry is the CONTENT of a string on the heap. Redacting one
   * of these is what the node-type rule already does by default.
   */
  isValue: boolean;
  /**
   * true when this entry is used as a class name, function name, property key,
   * closure variable or context slot — i.e. as part of the vocabulary a
   * retainer trace is written in. Redacting one of these costs debuggability,
   * so it is the decision worth thinking about.
   */
  isLabel: boolean;
  /**
   * how many edges in the whole snapshot use this entry as their name. A
   * programmer-written property name is reused; an identifier minted per record
   * is used once or twice. Useful for telling one from the other without
   * knowing the format.
   */
  labelUseCount: number;
  /**
   * character-class shape with runs collapsed, e.g. `d@a` for `4155551234@ex`
   * or `dadada-ada-da` for a UUID prefix. Lets a caller match a scheme by shape
   * instead of writing a precise regex.
   */
  shape: string;
};

/** One rule's contribution, as reported by {@link AnonymizeReport}. */
export type AnonymizeRuleCount = {
  /** the rule that matched, e.g. `dom-text` or `digit-run` */
  rule: string;
  /** how many distinct string table entries it matched */
  count: number;
};

/**
 * What {@link anonymizeHeapSnapshot} did, and — just as importantly — what it
 * left behind.
 */
export type AnonymizeReport = {
  /** the mode that was applied */
  mode: AnonymizationMode;
  /** whether a non-empty salt was used */
  salted: boolean;
  /** number of entries in the string table before anonymization */
  stringTableSize: number;
  /** string values redacted because they are the content of a string node */
  valuesRedacted: number;
  /**
   * how many redacted values were written to an APPENDED table entry rather
   * than over the original. The string table is deduplicated, so one entry can
   * be both a string's value and a property name; splitting is what keeps
   * redaction from destroying the label.
   */
  entriesSplit: number;
  /** entries redacted everywhere because their content looked sensitive */
  contentRedacted: number;
  /** the per-rule breakdown of `contentRedacted` */
  contentRedactedByRule: AnonymizeRuleCount[];
  /**
   * machine-generated-looking labels still in the clear, most common first.
   * Review these: anything here that is an identifier in YOUR application is a
   * residual leak, and the fix is to pass it as an `extraPatterns` entry. See
   * {@link UnclassifiedLabelFamily}.
   */
  unclassifiedLabelFamilies: UnclassifiedLabelFamily[];
};

type ContentRule = {
  name: string;
  test: (value: string) => boolean;
};

const DEFAULT_MIN_DIGIT_RUN = 9;

/**
 * Content rules applied to EVERY string table entry, label or not.
 *
 * Deliberately shape-based and application-agnostic: an anchored word list
 * would be a list of the leaks someone already thought of. `\d{9,}` is
 * unanchored on purpose — it is what catches an identifier embedded in a
 * composite key, which is the common shape for a per-contact or per-session
 * map key.
 *
 * URLs are NOT in this list. Script URLs are how `module attribution` and
 * script census name the code that owns memory, so redacting them would remove
 * a primary analysis while catching data that is, as a string VALUE, already
 * redacted by the node-type rule. A URL carrying a token in its query string is
 * a real residual; it is reported as such rather than silently handled.
 */
/**
 * A caller's regex may carry `/g` or `/y`, whose `lastIndex` makes `test`
 * alternate between true and false on identical input. Rebuilt without them so
 * the same value always classifies the same way.
 */
function withoutStatefulFlags(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
}

function buildContentRules(options: AnonymizeOptions): ContentRule[] {
  const rules: ContentRule[] = [];
  if (options.redactDomText !== false) {
    rules.push({
      name: 'dom-text',
      // Blink element descriptions and any serialized markup.
      test: v => /^\s*<[a-zA-Z!/]/.test(v),
    });
  }
  if (options.redactIdentifierKeys !== false) {
    const minRun = options.minDigitRunLength ?? DEFAULT_MIN_DIGIT_RUN;
    // Interpolated straight into a quantifier, so an out-of-range value is not
    // a mild misconfiguration: `0` yields `\d{0,}`, which matches EVERY string
    // and would redact the entire label vocabulary -- silently, since the run
    // would look successful. A negative or fractional value throws a
    // SyntaxError from deep inside RegExp construction instead of naming the
    // option that was wrong. Rejecting here fails loudly and early.
    if (!Number.isInteger(minRun) || minRun < 1) {
      throw new Error(
        `minDigitRunLength must be a positive integer, got: ${String(minRun)}. ` +
          `A value below 1 matches every string and would redact the whole ` +
          `label vocabulary.`,
      );
    }
    const digitRun = new RegExp(`\\d{${minRun},}`);
    rules.push(
      {
        // Named for the shape, not for email: `local@domain.tld` is also the
        // shape of a federated handle, and on one real capture that is what
        // most of the matches were. Calling the rule `email` would have
        // under-reported what it actually removed.
        name: 'email-or-handle',
        test: v => /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(v),
      },
      {
        name: 'credential',
        test: v => /^(Bearer\s|eyJ[A-Za-z0-9_-]{8,}\.)/.test(v),
      },
      {name: 'data-uri', test: v => /^data:[\w.+-]+\/[\w.+-]+[;,]/i.test(v)},
      {
        name: 'long-base64',
        // Mixed case AND a digit are required, not just the base64 character
        // set. Real base64 of real bytes has both; a long single-case run is
        // far more likely to be a module path segment, a minified identifier —
        // or this tool's own replacement text, which must not re-match on a
        // second pass or in an audit.
        test: v =>
          v.length >= 40 &&
          /^[A-Za-z0-9+/]+={0,2}$/.test(v) &&
          /[A-Z]/.test(v) &&
          /[a-z]/.test(v) &&
          /[0-9]/.test(v),
      },
      {name: 'digit-run', test: v => digitRun.test(v)},
    );
  }
  for (let i = 0; i < (options.extraPatterns?.length ?? 0); ++i) {
    // Compiled ONCE, here, not inside `test`. `test` runs for every entry in
    // the string table -- 732,455 of them on one real capture -- so compiling
    // inside the closure would recompile the same pattern once per entry per
    // caller pattern.
    const compiled = withoutStatefulFlags(
      (options.extraPatterns as RegExp[])[i],
    );
    rules.push({
      name: `extra-pattern-${i + 1}`,
      test: v => compiled.test(v),
    });
  }
  return rules;
}

/**
 * Length-preserving replacement text.
 *
 * Length is preserved in UTF-16 code units so `self_size` keeps agreeing with
 * the string it describes — V8 sizes a one-byte string at `align4(12 + length)`,
 * and a reader that checks will otherwise see a corrupt capture. The output is
 * ASCII, so it can never be longer in bytes than what it replaces.
 */
function redactedText(
  value: string,
  mode: AnonymizationMode,
  salt: string,
): string {
  const len = value.length;
  if (len === 0) {
    return value;
  }
  if (mode === 'uniform') {
    return '?'.repeat(len);
  }
  // Lowercase letters only, NOT hex. Replacement text is scanned by the very
  // content rules that decide what is sensitive, so digit-bearing fill makes
  // the tool's own output look like the thing it removes: with hex fill a real
  // capture still reported 17,837 entries carrying a 9-digit run AFTER
  // anonymization, essentially all of them replacements rather than leaks. A
  // digit-free alphabet is what keeps a reported residual meaningful.
  // Filled into a preallocated array and joined once, rather than accumulated
  // with `+=`. The values being replaced include serialized DOM node names that
  // reach tens of kilobytes, so this loop runs per character of the longest
  // string in the capture; it also stops exactly at `len` instead of
  // overshooting by up to a digest and slicing the remainder away.
  const chars = new Array<string>(len);
  let filled = 0;
  let counter = 0;
  while (filled < len) {
    const digest = crypto
      .createHash('sha256')
      .update(salt)
      .update(' ')
      .update(value)
      .update(` ${counter++}`)
      .digest();
    for (let i = 0; i < digest.length && filled < len; ++i) {
      chars[filled++] =
        REDACTION_ALPHABET[digest[i] % REDACTION_ALPHABET.length];
    }
  }
  return chars.join('');
}

const REDACTION_ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

type SnapshotLayout = {
  nodeFieldsCount: number;
  nodeTypeOffset: number;
  nodeNameOffset: number;
  stringNodeTypes: Set<number>;
  edgeFieldsCount: number;
  edgeTypeOffset: number;
  edgeNameOffset: number;
  indexNamedEdgeTypes: Set<number>;
};

/**
 * Record width implied by the DATA, not by the declared field list.
 *
 * `HeapSnapshot._buildMetaData` appends `'invisible'` to `meta.edge_fields` in
 * place while parsing, so a parsed snapshot claims one more edge field than its
 * edge array actually carries. Striding by the declared count reads every edge
 * misaligned — and silently, since the numbers still look like numbers.
 */
function fittedFieldCount(
  values: ArrayLike<number>,
  recordCount: number,
  declared: number,
): number {
  if (recordCount <= 0) {
    return declared;
  }
  const width = values.length / recordCount;
  return Number.isInteger(width) && width > 0 ? width : declared;
}

/** Rule name reported for entries the caller's own callback selected. */
const CUSTOM_RULE = 'custom-callback';
/** Kept distinct from the positional built-in rule indices. */
const CUSTOM_RULE_ID = 1 << 30;

const MAX_REPORTED_FAMILIES = 12;
const MAX_FAMILY_EXAMPLES = 3;

/**
 * Coarse shape of a string: character classes, with runs collapsed.
 *
 * `7ac91e02-11bd-4c7f` and `0f31ba77-92cd-4e10` both reduce to `dada-dada-dada`
 * -ish, while `enableFastPath` reduces to `aAaAa`. Separators survive
 * literally, because they are what makes a generated format recognizable.
 */
function shapeSignature(value: string): string {
  let out = '';
  let last = '';
  const limit = Math.min(value.length, 48);
  for (let i = 0; i < limit; ++i) {
    const c = value[i];
    let cls: string;
    if (c >= '0' && c <= '9') {
      cls = 'd';
    } else if (c >= 'a' && c <= 'z') {
      cls = 'a';
    } else if (c >= 'A' && c <= 'Z') {
      cls = 'A';
    } else {
      cls = c;
    }
    if (cls !== last) {
      out += cls;
      last = cls;
    }
  }
  return out;
}

/**
 * Group the labels still in the clear into machine-generated-looking families.
 *
 * Two exclusions, both engine-level facts rather than judgements about any
 * application:
 *
 * - **Pure digit strings.** V8 emits an exhaustive run of numeric index names
 *   (`"0"`..`"9"`, `"10"`..`"99"`, and so on); they are array indices by
 *   construction, and on one capture they were 133,226 of the labels, which
 *   would bury everything else.
 * - **Retainer descriptors.** Strings of the form `N / part of key (...) ->
 *   value (...)` are written by the snapshot serializer to describe WeakMap
 *   entries. They are diagnostics, never application data.
 *
 * What remains is filtered to shapes that carry a digit or a separator. A shape
 * built only from letters, `_` and `$` is the shape of source-code vocabulary
 * in every language, so surfacing those would make the report mostly noise —
 * and unlike a redaction rule, being wrong here only costs a line of output.
 */
function collectUnclassifiedLabelFamilies(
  strings: string[],
  isLabel: Uint8Array,
  contentRule: Int32Array,
  limit: number,
): UnclassifiedLabelFamily[] {
  const families = new Map<string, {count: number; examples: string[]}>();
  const vocabularyShape = /^[aA_$]+$/;
  for (let i = 0; i < isLabel.length; ++i) {
    if (!isLabel[i] || contentRule[i] >= 0) {
      continue;
    }
    const value = strings[i];
    if (value.length === 0 || /^\d+$/.test(value) || /^\d+ \/ /.test(value)) {
      continue;
    }
    const shape = shapeSignature(value);
    if (vocabularyShape.test(shape)) {
      continue;
    }
    let entry = families.get(shape);
    if (entry == null) {
      entry = {count: 0, examples: []};
      families.set(shape, entry);
    }
    entry.count++;
    if (entry.examples.length < MAX_FAMILY_EXAMPLES) {
      entry.examples.push(value);
    }
  }
  return [...families]
    .map(([shape, {count, examples}]) => ({shape, count, examples}))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * Read the node layout out of the snapshot's own meta rather than assuming it.
 *
 * Field order and the node type list are both snapshot-declared and differ
 * between engines and V8 versions (a browser capture has 6 node fields, a
 * Node.js one has 7).
 */
function readLayout(raw: RawHeapSnapshot): SnapshotLayout {
  const meta = raw.snapshot.meta as HeapSnapshotMeta;
  const nodeFields = meta.node_fields as unknown as string[];
  const nodeTypeOffset = nodeFields.indexOf('type');
  const nodeTypes = (meta.node_types as unknown as unknown[])[
    nodeTypeOffset
  ] as string[];
  const stringNodeTypes = new Set<number>();
  for (const name of ['string', 'concatenated string', 'sliced string']) {
    const idx = nodeTypes.indexOf(name);
    if (idx >= 0) {
      stringNodeTypes.add(idx);
    }
  }

  const edgeFields = meta.edge_fields as unknown as string[];
  const edgeTypeOffset = edgeFields.indexOf('type');
  const edgeTypes = (meta.edge_types as unknown as unknown[])[
    edgeTypeOffset
  ] as string[];
  // For `element` and `hidden` edges `name_or_index` is an integer index; for
  // every other type it is an index into the string table.
  const indexNamedEdgeTypes = new Set<number>();
  for (const name of ['element', 'hidden']) {
    const idx = edgeTypes.indexOf(name);
    if (idx >= 0) {
      indexNamedEdgeTypes.add(idx);
    }
  }

  return {
    nodeFieldsCount: fittedFieldCount(
      raw.nodes,
      raw.snapshot.node_count,
      nodeFields.length,
    ),
    nodeTypeOffset,
    nodeNameOffset: nodeFields.indexOf('name'),
    stringNodeTypes,
    edgeFieldsCount: fittedFieldCount(
      raw.edges,
      raw.snapshot.edge_count,
      edgeFields.length,
    ),
    edgeTypeOffset,
    edgeNameOffset: edgeFields.indexOf('name_or_index'),
    indexNamedEdgeTypes,
  };
}

/**
 * Rewrite a parsed heap snapshot in place so it no longer carries user data.
 *
 * Redacts the content of every string on the heap, plus any string table entry
 * whose text looks like an identifier, a credential or serialized DOM. Class
 * names, function names and ordinary property keys are left alone, so retainer
 * traces, class histograms, dominator trees and shape analyses all still work
 * on the result.
 *
 * The snapshot is modified in place and its parsed view updates with it — node
 * names are read from the string table on each access rather than cached.
 * Persist the result with {@link serializeHeapSnapshot}.
 *
 * This does not defeat a determined attacker who already knows what they are
 * looking for: lengths are preserved exactly (they have to be, or `self_size`
 * stops matching), and in `stable` mode equal values stay equal. It removes the
 * content, not the shape of the content.
 *
 * @param snapshot the parsed heap snapshot to rewrite in place
 * @param options see {@link AnonymizeOptions}
 * @returns a summary of what was redacted, per rule; see
 * {@link AnonymizeReport}
 *
 * * **Examples**:
 * ```typescript
 * import type {IHeapSnapshot} from '@memlab/core';
 * import {
 *   dumpNodeHeapSnapshot,
 *   anonymizeHeapSnapshot,
 *   serializeHeapSnapshot,
 * } from '@memlab/core';
 * import {getFullHeapFromFile} from '@memlab/heap-analysis';
 *
 * (async function () {
 *   const file = dumpNodeHeapSnapshot();
 *   const heap: IHeapSnapshot = await getFullHeapFromFile(file);
 *
 *   const report = anonymizeHeapSnapshot(heap);
 *   console.log(`redacted ${report.valuesRedacted} string values`);
 *
 *   serializeHeapSnapshot(heap, '/tmp/shareable.heapsnapshot');
 * })();
 * ```
 */
export function anonymizeHeapSnapshot(
  snapshot: IHeapSnapshot,
  options: AnonymizeOptions = {},
): AnonymizeReport {
  return anonymizeRawHeapSnapshot(snapshot.snapshot, options);
}

/**
 * The in-place rewrite, against the raw snapshot data.
 *
 * @param raw the raw snapshot data to rewrite
 * @param options see {@link AnonymizeOptions}
 * @returns a summary of what was redacted; see {@link AnonymizeReport}
 *
 * @internal
 */
export function anonymizeRawHeapSnapshot(
  raw: RawHeapSnapshot,
  options: AnonymizeOptions = {},
): AnonymizeReport {
  const mode: AnonymizationMode = options.mode ?? 'stable';
  const salt = options.salt ?? '';
  const strings = raw.strings;
  const layout = readLayout(raw);
  const rules = buildContentRules(options);
  // Same reason as the extra patterns: this is consulted once per string table
  // entry, so the sanitized regexes are built here rather than in the loop.
  const keep = (options.keepPatterns ?? []).map(withoutStatefulFlags);

  const {
    nodeFieldsCount,
    nodeTypeOffset,
    nodeNameOffset,
    stringNodeTypes,
    edgeFieldsCount,
    edgeTypeOffset,
    edgeNameOffset,
    indexNamedEdgeTypes,
  } = layout;

  // Classify every string table entry by HOW IT IS REACHED. The table is
  // deduplicated, so one entry can be reached both ways at once, and the two
  // roles need opposite treatment.
  const nodes = raw.nodes;
  const isStringValue = new Uint8Array(strings.length);
  const isLabel = new Uint8Array(strings.length);
  for (let i = 0; i < nodes.length; i += nodeFieldsCount) {
    const nameIdx = nodes[i + nodeNameOffset];
    if (stringNodeTypes.has(nodes[i + nodeTypeOffset])) {
      // the CONTENT of a JS string on the heap: data
      isStringValue[nameIdx] = 1;
    } else {
      // a class name, function name, or engine-internal name: a label
      isLabel[nameIdx] = 1;
    }
  }
  const edges = raw.edges;
  const nameUseCount = new Uint32Array(strings.length);
  for (let i = 0; i < edges.length; i += edgeFieldsCount) {
    if (!indexNamedEdgeTypes.has(edges[i + edgeTypeOffset])) {
      // a property key, closure variable, or context slot name: a label
      const nameIdx = edges[i + edgeNameOffset];
      isLabel[nameIdx] = 1;
      if (nameUseCount[nameIdx] < 0xffffffff) {
        nameUseCount[nameIdx]++;
      }
    }
  }

  const ruleCounts = new Map<string, number>();
  // -1 = not content-sensitive; CUSTOM_RULE_ID for the caller's callback;
  // otherwise the index of the matching built-in rule.
  const contentRule = new Int32Array(strings.length).fill(-1);
  // Entries the caller explicitly protected. Tracked separately from
  // `contentRule` because protection has to reach the string-VALUE pass below,
  // which does not consult the content rules at all: `keepPatterns` promises
  // an entry is NEVER redacted, and `shouldRedact` returning false promises the
  // same, so honouring either only for content rules would break both
  // contracts for exactly the entries a caller cared enough to name.
  const protectedEntry = new Uint8Array(strings.length);
  const shouldRedact = options.shouldRedact;
  let contentRedacted = 0;
  for (let i = 0; i < strings.length; ++i) {
    const value = strings[i];
    if (value.length === 0) {
      continue;
    }
    if (shouldRedact != null) {
      // Asked first, and its answer is final either way. The caller knows their
      // own application; the built-in rules only know internet formats.
      const verdict = shouldRedact(value, {
        isValue: isStringValue[i] === 1,
        isLabel: isLabel[i] === 1,
        labelUseCount: nameUseCount[i],
        shape: shapeSignature(value),
      });
      if (verdict === true) {
        contentRule[i] = CUSTOM_RULE_ID;
        contentRedacted++;
        ruleCounts.set(CUSTOM_RULE, (ruleCounts.get(CUSTOM_RULE) ?? 0) + 1);
        continue;
      }
      if (verdict === false) {
        protectedEntry[i] = 1;
        continue;
      }
    }
    if (keep.some(p => p.test(value))) {
      protectedEntry[i] = 1;
      continue;
    }
    for (let r = 0; r < rules.length; ++r) {
      if (rules[r].test(value)) {
        contentRule[i] = r;
        contentRedacted++;
        ruleCounts.set(rules[r].name, (ruleCounts.get(rules[r].name) ?? 0) + 1);
        break;
      }
    }
  }

  // Content matches are redacted where they stand, because the value is
  // sensitive wherever it appears — including as a property name.
  for (let i = 0; i < strings.length; ++i) {
    if (contentRule[i] >= 0) {
      strings[i] = redactedText(strings[i], mode, salt);
    }
  }

  // Now the string values. Which of two treatments applies turns on whether
  // the same entry is ALSO a label:
  //
  //   value only  -> redact the entry in place. Splitting here would be a leak,
  //                  not a safeguard: repointing the node at a redacted twin
  //                  leaves the original entry sitting in the table with the
  //                  plaintext still in it. Nothing references it, but the
  //                  bytes are in the file, which is all an attacker needs.
  //   value+label -> append a redacted twin and repoint only the string node,
  //                  so the label keeps its text. Overwriting in place would
  //                  destroy a property or class name that merely happens to
  //                  share the deduplicated entry.
  const twinOf = new Int32Array(strings.length).fill(-1);
  let valuesRedacted = 0;
  let entriesSplit = 0;
  const originalTableSize = strings.length;
  for (let i = 0; i < originalTableSize; ++i) {
    if (
      !isStringValue[i] ||
      isLabel[i] ||
      contentRule[i] >= 0 ||
      protectedEntry[i]
    ) {
      continue;
    }
    if (strings[i].length === 0) {
      continue;
    }
    strings[i] = redactedText(strings[i], mode, salt);
    valuesRedacted++;
  }
  for (let i = 0; i < nodes.length; i += nodeFieldsCount) {
    if (!stringNodeTypes.has(nodes[i + nodeTypeOffset])) {
      continue;
    }
    const nameIdx = nodes[i + nodeNameOffset];
    if (
      !isLabel[nameIdx] ||
      contentRule[nameIdx] >= 0 ||
      protectedEntry[nameIdx] ||
      strings[nameIdx].length === 0
    ) {
      // redacted in place above, redacted by content, or nothing to redact
      continue;
    }
    if (twinOf[nameIdx] < 0) {
      twinOf[nameIdx] = strings.length;
      strings.push(redactedText(strings[nameIdx], mode, salt));
      valuesRedacted++;
      entriesSplit++;
    }
    nodes[i + nodeNameOffset] = twinOf[nameIdx];
  }

  const contentRedactedByRule: AnonymizeRuleCount[] = [...ruleCounts]
    .map(([rule, count]) => ({rule, count}))
    .sort((a, b) => b.count - a.count);

  return {
    mode,
    salted: salt.length > 0,
    stringTableSize: originalTableSize,
    valuesRedacted,
    entriesSplit,
    contentRedacted,
    contentRedactedByRule,
    unclassifiedLabelFamilies: collectUnclassifiedLabelFamilies(
      strings,
      isLabel,
      contentRule,
      MAX_REPORTED_FAMILIES,
    ),
  };
}

/**
 * Read a snapshot file into its raw arrays, WITHOUT building the object graph.
 *
 * `HeapParser.parse` additionally computes referrers, dominators, detachedness
 * and node indices — on a 7.1M-node capture that is the part that costs ~15
 * seconds and several gigabytes. Anonymization needs none of it: it works off
 * node types, edge names and the string table. Reading the arrays and stopping
 * there is the difference between "shareable in a moment" and "load the whole
 * heap first".
 *
 * @param file absolute path of the `.heapsnapshot` file to read
 * @returns the snapshot's raw arrays
 *
 * @internal
 */
/**
 * The three phases {@link anonymizeHeapSnapshotFile} moves through. Reading is
 * the slow one on a large capture — a multi-hundred-MB `.heapsnapshot` spends
 * most of its wall clock in the parse, before anything is redacted.
 */
export type AnonymizePhase = 'read' | 'anonymize' | 'write';

/**
 * Called as each phase STARTS, so a caller can show which one is running.
 *
 * Phase-level rather than byte-level on purpose: the parse is a single
 * `JSON.parse` over the non-typed-array remainder, so there is no honest
 * intermediate percentage to report from inside it. Saying "reading" and
 * meaning it beats a bar that fabricates progress.
 */
export type AnonymizeProgressCallback = (
  phase: AnonymizePhase,
  step: number,
  totalSteps: number,
) => void;

export async function readRawHeapSnapshot(
  file: string,
): Promise<RawHeapSnapshot> {
  const [nodes, edges, locations, content] = await Promise.all([
    stringLoader.readFileAndExtractTypedArray(file, 'nodes'),
    stringLoader.readFileAndExtractTypedArray(file, 'edges'),
    stringLoader.readFileAndExtractTypedArray(file, 'locations'),
    stringLoader.readFileAndExcludeTypedArray(file, [
      'nodes',
      'edges',
      'locations',
    ]),
  ]);
  const raw = JSON.parse(content) as RawHeapSnapshot;
  raw.nodes = nodes as unknown as number[];
  raw.edges = edges as unknown as number[];
  raw.locations = locations as unknown as number[];
  return raw;
}

/**
 * Anonymize a `.heapsnapshot` file and write the result to another file.
 *
 * The file-to-file form of {@link anonymizeHeapSnapshot}, and the one to reach
 * for when the capture is only being shared rather than analyzed here: it skips
 * building the object graph on the way in, and streams on the way out, so
 * neither the input nor the output is ever held as one string.
 *
 * @param inputFile absolute path of the capture to read
 * @param outputFile absolute path to write the anonymized capture to; an
 * existing file at that path is overwritten
 * @param options see {@link AnonymizeOptions}
 * @returns a summary of what was redacted, and what was left in the clear; see
 * {@link AnonymizeReport}
 *
 * * **Examples**:
 * ```typescript
 * import {anonymizeHeapSnapshotFile} from '@memlab/core';
 *
 * (async function () {
 *   const report = await anonymizeHeapSnapshotFile(
 *     '/tmp/capture.heapsnapshot',
 *     '/tmp/shareable.heapsnapshot',
 *   );
 *   console.log(`redacted ${report.valuesRedacted} string values`);
 *   for (const family of report.unclassifiedLabelFamilies) {
 *     console.log(`still in the clear: ${family.count} x ${family.shape}`);
 *   }
 * })();
 * ```
 */
export async function anonymizeHeapSnapshotFile(
  inputFile: string,
  outputFile: string,
  options: AnonymizeOptions = {},
  onProgress?: AnonymizeProgressCallback,
): Promise<AnonymizeReport> {
  if (resolveForComparison(inputFile) === resolveForComparison(outputFile)) {
    throw new Error(
      `anonymizeHeapSnapshotFile: outputFile resolves to the same file as ` +
        `inputFile (${inputFile}). Writing there would overwrite the only ` +
        `unredacted copy of the capture.`,
    );
  }
  onProgress?.('read', 1, 3);
  const raw = await readRawHeapSnapshot(inputFile);
  onProgress?.('anonymize', 2, 3);
  const report = anonymizeRawHeapSnapshot(raw, options);
  onProgress?.('write', 3, 3);
  serializeRawHeapSnapshot(raw, outputFile);
  return report;
}

/**
 * Report what anonymizing a capture WOULD remove, and what it would leave,
 * without writing anything.
 *
 * Point it at a capture someone already anonymized to find out whether they
 * missed something: `unclassifiedLabelFamilies` names the identifier-shaped
 * text still in the clear. Run against one already-anonymized capture, this is
 * what showed its author had removed every string VALUE and left 26,303 account
 * handles behind as property names.
 *
 * @param inputFile absolute path of the capture to inspect
 * @param options see {@link AnonymizeOptions}
 * @returns the same summary {@link anonymizeHeapSnapshotFile} returns, for a
 * run that was not written to disk
 *
 * * **Examples**:
 * ```typescript
 * import {auditHeapSnapshotFile} from '@memlab/core';
 *
 * (async function () {
 *   const report = await auditHeapSnapshotFile('/tmp/shared.heapsnapshot');
 *   console.log(report.unclassifiedLabelFamilies);
 * })();
 * ```
 */
export async function auditHeapSnapshotFile(
  inputFile: string,
  options: AnonymizeOptions = {},
  onProgress?: AnonymizeProgressCallback,
): Promise<AnonymizeReport> {
  onProgress?.('read', 1, 2);
  const raw = await readRawHeapSnapshot(inputFile);
  onProgress?.('anonymize', 2, 2);
  return anonymizeRawHeapSnapshot(raw, options);
}

/**
 * Canonical form of a path, for deciding whether two of them are the same file.
 *
 * A string comparison is not enough, and the cost of it being wrong here is the
 * original capture: `a.heapsnapshot` and `./a.heapsnapshot`, an absolute and a
 * relative spelling, or a symlink and its target are all distinct strings
 * naming one file. `realpathSync` resolves all three.
 *
 * The output file usually does not exist yet, which makes `realpathSync` throw
 * on it — so its DIRECTORY is canonicalized instead and the basename appended.
 * That still catches a symlinked parent, which a plain `path.resolve` would
 * miss. Falls back to `path.resolve` when even the directory is absent, since
 * at that point the two cannot be the same existing file anyway.
 *
 * @param file the path to canonicalize
 * @returns a path safe to compare against another canonicalized path
 *
 * @internal
 */
export function resolveForComparison(file: string): string {
  const resolved = path.resolve(file);
  try {
    return fs.realpathSync(resolved);
  } catch {
    try {
      return path.join(
        fs.realpathSync(path.dirname(resolved)),
        path.basename(resolved),
      );
    } catch {
      return resolved;
    }
  }
}
