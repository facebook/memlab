/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

export {default as PlaywrightHeapCapturer} from './capturer';
export type {
  LeakFilterFn,
  PageLike,
  PhaseLabel,
  PlaywrightHeapCapturerOptions,
} from './capturer';
export type {CDPLike} from './snapshot';
export {writeHeapSnapshot, forceFullGC} from './snapshot';
