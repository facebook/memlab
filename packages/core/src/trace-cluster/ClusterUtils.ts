/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import ClusterUtils from './ClusterUtilsHelper';
import ClusteringHeuristics from './ClusteringHeuristics';

export default ClusterUtils.initialize(ClusteringHeuristics);
