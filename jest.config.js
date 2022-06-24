/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

const config = {
  verbose: true,
  testRegex: '((.*/)?__tests__/.*)(\\.test|\\.spec)\\.(ts|tsx)?$',
  maxConcurrency: 1,
  preset: 'ts-jest',
  testEnvironment: 'node',
};

module.exports = config;
