/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {Optional} from './types';

const displayNameBlockList = new Set();

export function isValidComponentName(name: Optional<string>): boolean {
  return name != null && !displayNameBlockList.has(name);
}
