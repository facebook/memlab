/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

const config = {
  verbose: true,
  testRegex: '(/dist/(.*/)?__tests__/.*)(\\.test|\\.spec)\\.jsx?$',
  maxConcurrency: 1,
};

module.exports = config;
