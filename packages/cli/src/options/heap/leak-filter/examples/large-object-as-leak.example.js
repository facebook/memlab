/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

module.exports = function leakFilter(node, _snapshot, _leakedNodeIds) {
  return node.retainedSize > 1000000;
};
