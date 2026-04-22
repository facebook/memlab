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

/** Ordered phase labels captured by the memlab fixture. */
export const PHASE_LABELS = ['baseline', 'target', 'final'] as const;
export type PhaseLabel = (typeof PHASE_LABELS)[number];

/**
 * Callback deciding whether a live heap node should be reported as a leak.
 * Mirrors `ILeakFilter.leakFilter`.
 */
export type LeakFilterFn = NonNullable<ILeakFilter['leakFilter']>;

/** GC-cycle tuning for the `final` snapshot. See {@link GCOptions}. */
export type MemlabGCOptions = GCOptions;

/** User configuration merged via `MemlabFixture.configure`. */
export type MemlabConfigInput = {
  leakFilter?: LeakFilterFn;
  gc?: MemlabGCOptions;
};

/** Fixture surface injected into every test that destructures `memlab`. */
export type MemlabFixture = {
  mark(label: PhaseLabel): Promise<void>;
  baseline(): Promise<void>;
  target(): Promise<void>;
  final(): Promise<void>;
  configure(config: MemlabConfigInput): void;
  findLeaks(): Promise<ISerializedInfo[] | null>;
};

export type {Page};
