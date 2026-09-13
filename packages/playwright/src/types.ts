/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {Page} from '@playwright/test';
import type {ILeakFilter, ISerializedInfo} from '@memlab/core';
import type {GCOptions} from './snapshot';

export const PHASE_LABELS = ['baseline', 'target', 'final'] as const;
export type PhaseLabel = (typeof PHASE_LABELS)[number];

export type LeakFilterFn = NonNullable<ILeakFilter['leakFilter']>;
export type MemlabGCOptions = GCOptions;

export type MemlabConfigInput = {
  leakFilter?: LeakFilterFn;
  gc?: MemlabGCOptions;
};

export type MemlabFixture = {
  mark(label: PhaseLabel): Promise<void>;
  baseline(): Promise<void>;
  target(): Promise<void>;
  final(): Promise<void>;
  configure(config: MemlabConfigInput): void;
  findLeaks(): Promise<ISerializedInfo[] | null>;
  expectNoLeaks(): Promise<void>;
};

export type {Page};
