/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
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
