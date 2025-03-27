/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

module.exports = function leakFilter(node, _snapshot, _leakedNodeIds) {
  return node.retainedSize > 1000000;
};
