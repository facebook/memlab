/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {SnapshotEnv} from './heap-state.js';

/**
 * Was this snapshot captured with numeric-value capture on?
 *
 * Background: `heap number` is a perennial top grower, and the standing advice
 * was "that is probably a capture artifact — check whether you captured with
 * numeric values on". That advice pushed a decision onto the caller that the
 * caller usually cannot answer (the snapshot may be days old, or captured by
 * someone else), and it rested on a mechanism that was never measured.
 *
 * It was measured for this change, with matched pairs — the same program/page,
 * two snapshots differing ONLY in the `captureNumericValue` CDP flag:
 *
 *  - **Node.js** (`inspector` → `HeapProfiler.takeHeapSnapshot`): the flag adds
 *    `smi number` nodes and nothing else. Off: 10,100 number nodes, zero of them
 *    `smi number`. On: 10,390, of which 290 `smi number`. `heap number` was
 *    IDENTICAL at 10,100 in both. Smis are immediate values, not heap objects,
 *    so they only become graph nodes when the flag asks V8 to materialize them —
 *    which makes their presence a sound detector here.
 *  - **Chrome**: no detectable difference at all. On a page holding 20,000
 *    objects each with a double and a Smi field, on and off produced the same
 *    populations to the node: 40,026 `heap number`, 20,000 `smi number`, 1,063
 *    `int`. Chrome emits `smi number` either way, so the Node detector does not
 *    transfer, and no other field varies.
 *
 * Neither environment ever encodes the numeric VALUE in the node name (0
 * value-named number nodes across all four snapshots), so name-based detection
 * — the approach a previous round tried and rejected — cannot work in principle.
 *
 * Two consequences, both of which change what the tools should say:
 *  1. For a BROWSER snapshot the question is not merely unanswerable, it is
 *     moot: the flag changes nothing, so `heap number` growth in a browser
 *     capture is never a numeric-capture artifact and must be investigated as
 *     real.
 *  2. The old claim that the mode "emits one node per distinct number and ~3x
 *     inflates the graph" is not what was measured in either environment.
 */
export type NumericCaptureMode = 'on' | 'off' | 'not-applicable' | 'unknown';

export interface NumericCaptureVerdict {
  mode: NumericCaptureMode;
  /** One sentence stating the answer, for direct inclusion in a tool result. */
  note: string;
}

/**
 * @param env  which runtime produced the snapshot
 * @param hasSmiNumberNodes whether any `smi number` node is present
 */
export function classifyNumericCapture(
  env: SnapshotEnv,
  hasSmiNumberNodes: boolean,
): NumericCaptureVerdict {
  if (env === 'browser') {
    return {
      mode: 'not-applicable',
      note: 'This is a **browser** capture, where `capture_numeric_value` makes no difference to the snapshot: a matched pair taken with the flag on and off produced identical number-node populations (40,026 `heap number` / 20,000 `smi number` in both). So `heap number` growth here is **not** a numeric-capture artifact — treat it as real and trace it with `memlab_retainer_summary` on `heap number`.',
    };
  }
  if (env === 'node') {
    return hasSmiNumberNodes
      ? {
          mode: 'on',
          note: 'This **Node.js** capture was taken with **numeric-value capture ON** — `smi number` nodes are present, and V8 only materializes Smis as graph nodes in that mode. `smi number` growth is therefore a capture artifact. `heap number` is emitted either way (a matched pair had an identical `heap number` count with the flag on and off), so `heap number` growth is still worth investigating.',
        }
      : {
          mode: 'off',
          note: 'This **Node.js** capture was taken with **numeric-value capture OFF** (no `smi number` nodes present). `heap number` nodes are therefore ordinary boxed doubles that V8 allocates anyway — this growth may be real, so investigate it rather than dismissing it.',
        };
  }
  return {
    mode: 'unknown',
    note: 'The runtime that produced this snapshot could not be identified, so the numeric-capture mode cannot be stated. In browser captures the flag makes no difference; in Node.js captures it adds `smi number` nodes.',
  };
}

/** Class-histogram key for the marker node type, as `type::name`. */
export const SMI_NUMBER_CLASS_KEY = 'number::smi number';
