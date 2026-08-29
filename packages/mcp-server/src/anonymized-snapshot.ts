/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapSnapshot} from '@memlab/core';

/**
 * Has this capture had its string content replaced — and if so, in a way that
 * corrupts the duplication numbers, or not?
 *
 * Anonymisers replace string CONTENT while preserving LENGTH. Whether that
 * matters to an analysis depends entirely on which kind you are looking at, so
 * this reports three states rather than a boolean:
 *
 * - `uniform` — every character replaced by ONE filler character. Every
 *   distinct string of a given length collapses into the same value, so every
 *   string-duplication analysis measures the anonymiser instead of the app.
 *   Measured on one such capture: `memlab_quick_diagnosis` reported **"Total
 *   interning savings: 47.4 MB"** and `memlab_duplicated_strings` reported a
 *   single 5.2 KB string duplicated 939 times for 42.1 MB. Both were pure
 *   artifact. Nothing flagged it; it was caught only because the sample values
 *   rendered visibly as runs of `?`.
 * - `stable` — replaced by a value-derived token, so distinctness survives
 *   along with length. Duplication and interning figures are as true as on the
 *   original capture, and warning about them would make readers discard
 *   correct findings. Only the content is unreadable.
 * - `none` — an ordinary capture.
 *
 * Both tests are deliberately cheap and deliberately conservative: sample
 * strings, and only classify when a large majority match. A normal heap has
 * plenty of short repeated-character strings ("  ", "----") and plenty of short
 * lowercase words, so the length floor matters more than the ratio for either.
 */
export type AnonymizationKind =
  /** ordinary capture */
  | 'none'
  /**
   * every character replaced by one filler character. Length survives, so
   * distinct values of equal length collapse into one and duplication figures
   * become fiction.
   */
  | 'uniform'
  /**
   * replaced by a value-derived token. Length AND distinctness survive, so
   * duplication figures stay true; only the content is gone.
   */
  | 'stable';

export interface AnonymizationCheck {
  kind: AnonymizationKind;
  /**
   * true only for `uniform`, which is the kind that corrupts duplication
   * numbers. Existing call sites read this to decide whether to warn, and a
   * `stable` capture must NOT trip them — its numbers are trustworthy.
   */
  anonymized: boolean;
  sampled: number;
  singleCharRuns: number;
  tokenRuns: number;
  exampleChar?: string;
}

const MIN_LEN = 8;
const SAMPLE_TARGET = 400;
const RATIO = 0.8;

export function detectAnonymizedStrings(
  snapshot: IHeapSnapshot,
): AnonymizationCheck {
  let sampled = 0;
  let singleCharRuns = 0;
  let tokenRuns = 0;
  let exampleChar: string | undefined;
  let visited = 0;

  snapshot.nodes.forEach(node => {
    if (sampled >= SAMPLE_TARGET) return;
    if (node.type !== 'string') return;
    // Stride rather than take the first N: the first strings in a heap are
    // V8 internals and interned literals, which are never anonymised and would
    // make every capture look clean.
    visited++;
    if (visited % 7 !== 0) return;
    const value = node.name;
    if (typeof value !== 'string' || value.length < MIN_LEN) return;
    sampled++;
    const first = value[0];
    let uniform = true;
    for (let i = 1; i < value.length; i++) {
      if (value[i] !== first) {
        uniform = false;
        break;
      }
    }
    if (uniform) {
      singleCharRuns++;
      exampleChar ??= first;
      return;
    }
    // `stable` fill is a run of lowercase letters and nothing else. Real string
    // values of this length essentially always carry a space, digit, capital or
    // punctuation mark somewhere, so a heap where most of them are bare
    // lowercase runs has been rewritten.
    if (/^[a-z]+$/.test(value)) {
      tokenRuns++;
    }
  });

  const uniformRatio = sampled >= 20 ? singleCharRuns / sampled : 0;
  const tokenRatio = sampled >= 20 ? tokenRuns / sampled : 0;
  const kind: AnonymizationKind =
    uniformRatio >= RATIO ? 'uniform' : tokenRatio >= RATIO ? 'stable' : 'none';

  return {
    kind,
    anonymized: kind === 'uniform',
    sampled,
    singleCharRuns,
    tokenRuns,
    exampleChar,
  };
}

/** The banner every string-content tool prints when the capture is anonymised. */
export function anonymizedStringsBanner(check: AnonymizationCheck): string {
  if (check.kind === 'stable') {
    // Deliberately NOT a warning about the numbers. `stable` anonymization
    // preserves distinctness, so duplication and interning figures are exactly
    // as true as on the original capture — saying otherwise here would make
    // readers discard correct findings.
    const pct = check.sampled
      ? Math.round((check.tokenRuns / check.sampled) * 100)
      : 0;
    return (
      `> ℹ️ **This capture is ANONYMISED (value-stable) — ${pct}% of sampled string values are opaque tokens.** ` +
      'String CONTENT has been replaced, but lengths and distinctness were preserved, so counts, sizes, duplication and interning figures below are accurate. ' +
      'What you cannot do is read the strings: a sample value tells you nothing about the real data, so identify records by property shape rather than by value.'
    );
  }
  const pct = check.sampled
    ? Math.round((check.singleCharRuns / check.sampled) * 100)
    : 0;
  return (
    `> ⚠️ **This capture looks ANONYMISED — ${pct}% of sampled strings are a single character (\`${check.exampleChar ?? '?'}\`) repeated.** ` +
    'An anonymiser replaces string content but preserves length, so every distinct string of the same length collapses to the same value. ' +
    '**Every duplication and interning figure below is manufactured by that collapse and does not exist in the real app.** ' +
    'Do not quote them, and do not open an interning task from them. Composition, populations, retainer paths and dominator-deduped sizes are unaffected and remain trustworthy.'
  );
}

/**
 * Prepend the anonymisation banner to a tool's output when it applies.
 *
 * Wraps the result rather than being left to each caller to remember, because
 * "remember to check" is exactly the failure this exists to prevent.
 */
export function withAnonymizedBanner(
  snapshot: IHeapSnapshot,
  text: string,
): string {
  const check = detectAnonymizedStrings(snapshot);
  if (check.kind === 'none') return text;
  return `${anonymizedStringsBanner(check)}\n\n${text}`;
}
