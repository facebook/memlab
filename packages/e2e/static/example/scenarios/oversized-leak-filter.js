/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * @nolint
 * @oncall web_perf_infra
 */

// leakFilter is called with each object (node) in browser
// allocated by `action` but not released after the `back` call
function leakFilter(node, _snapshot, _leakedNodeIds) {
  return node.retainedSize > 1000 * 1000;
}

module.exports = {leakFilter};
