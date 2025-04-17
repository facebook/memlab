/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {AnyValue, Config} from '../core/types';

// Performance Configuration
export const performanceConfig = {
  scanIntervalMs: 1000,
  maxComponentStackDepth: 100,
  memoryMeasurementIntervalMs: 5000,
};

// Feature Flags
export const featureFlags = {
  enableMutationObserver: true,
  enableMemoryTracking: true,
  enableComponentStack: true,
  enableConsoleLogs: (window as AnyValue)?.TEST_MEMORY_SCAN,
};

// overall Config
export const config: Config = {
  performance: performanceConfig,
  features: featureFlags,
};
