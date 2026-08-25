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
 * Is this capture anonymised — every string character replaced by a filler?
 *
 * Anonymisers replace string CONTENT while preserving LENGTH, which collapses
 * every distinct string of the same length into the same value. Every
 * string-duplication analysis then measures the anonymiser instead of the app,
 * and reports enormous savings that do not exist.
 *
 * Measured on one such capture: `memlab_quick_diagnosis` reported
 * **"Total interning savings: 47.4 MB"** and `memlab_duplicated_strings`
 * reported a single 5.2 KB string duplicated 939 times for 42.1 MB. Both
 * figures were pure artifact. Nothing in the tooling flagged it; it was caught
 * only because the sample values rendered visibly as runs of `?`.
 *
 * The test is deliberately cheap and deliberately conservative: sample strings,
 * and only call it anonymised when a large majority are a single character
 * repeated. A normal heap has plenty of short repeated-character strings
 * ("  ", "----"), so the length floor matters more than the ratio.
 */
export interface AnonymizationCheck {
  anonymized: boolean;
  sampled: number;
  singleCharRuns: number;
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
    }
  });

  return {
    anonymized: sampled >= 20 && singleCharRuns / sampled >= RATIO,
    sampled,
    singleCharRuns,
    exampleChar,
  };
}

/** The banner every string-content tool prints when the capture is anonymised. */
export function anonymizedStringsBanner(check: AnonymizationCheck): string {
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
  if (!check.anonymized) return text;
  return `${anonymizedStringsBanner(check)}\n\n${text}`;
}
