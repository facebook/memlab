/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @lightSyntaxTransform
 * @oncall web_perf_infra
 */

'use strict';

export const NodeDetachState = {
  Unknown: 0,
  Attached: 1,
  Detached: 2,
};

export function throwError(error: Error): Error {
  if (error) {
    error.stack;
  }
  throw error;
}
