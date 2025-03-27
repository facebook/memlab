/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * @nolint
 * @oncall memory_lab
 */

module.exports = function leakFilter(node, _snapshot, _leakedNodeIds) {
  return node.retainedSize > 1000 * 1000;
};
