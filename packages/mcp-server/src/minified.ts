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
 * Whether a snapshot comes from a minified (production-like) bundle.
 *
 * On a minified build, local variables and most function names are mangled
 * to one or two characters (`t`, `e`, `n`). A probe that looks up a class or a
 * closure-captured variable by its source name then finds nothing and reads 0.
 * That 0 means the probe could not find its holder, not that the population
 * is empty. Measured on WhatsApp Web: 54% of named closures had a 1-2
 * character name on a prod-like capture, against 6% on the dev build of the
 * same app.
 */

import type {IHeapSnapshot} from '@memlab/core';
import {formatNumber} from './utils.js';

const SHORT_NAME_MAX = 2;
const MINIFIED_SHARE = 0.3;
// Too few named closures to judge (a tiny or synthetic heap).
const MIN_NAMED_CLOSURES = 1000;

export interface MinifiedSignal {
  minified: boolean;
  shortNameShare: number;
  namedClosures: number;
}

const cache = new WeakMap<IHeapSnapshot, MinifiedSignal>();

export function minifiedSignal(snapshot: IHeapSnapshot): MinifiedSignal {
  const cached = cache.get(snapshot);
  if (cached != null) return cached;
  let named = 0;
  let short = 0;
  snapshot.nodes.forEach(node => {
    if (node.type !== 'closure') return;
    const len = node.name.length;
    if (len === 0) return;
    named++;
    if (len <= SHORT_NAME_MAX) short++;
  });
  const share = named > 0 ? short / named : 0;
  const signal = {
    minified: named >= MIN_NAMED_CLOSURES && share >= MINIFIED_SHARE,
    shortNameShare: share,
    namedClosures: named,
  };
  cache.set(snapshot, signal);
  return signal;
}

/** One warning line for a minified snapshot, or null. */
export function minifiedWarning(snapshot: IHeapSnapshot): string | null {
  const s = minifiedSignal(snapshot);
  if (!s.minified) return null;
  return (
    `⚠ **Minified build** (${(s.shortNameShare * 100).toFixed(0)}% of ${formatNumber(s.namedClosures)} named closures have a 1-2 character name). ` +
    'Class, function and closure-variable names are mangled, so a probe that looks one up by its source name ' +
    '(`byClass`, `byContextVar`, `allByEdgeName`, …) finds nothing and reads 0. ' +
    "Resolve module state through the module registry instead: `helpers.module('<ModuleName>')` and " +
    "`helpers.moduleExportProp('<ModuleName>', '<prop>', {class: 'Map'})`."
  );
}
