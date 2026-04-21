/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import {ConsoleMode, SnapshotResultReader, findLeaks} from '@memlab/api';
import {config as memlabConfig} from '@memlab/core';
import type {
  IHeapNode,
  IHeapSnapshot,
  ILeakFilter,
  ISerializedInfo,
} from '@memlab/core';

import {CDPLike, forceFullGC, writeHeapSnapshot} from './snapshot';

// Minimal Playwright Page surface we rely on. Kept as a structural type so
// consumers don't need `playwright` installed for the low-level capturer to
// type-check against arbitrary page-likes.
export interface PageLike {
  context(): {
    newCDPSession(page: PageLike): Promise<CDPLike>;
  };
}

export type PhaseLabel = 'baseline' | 'target' | 'final';

/**
 * Callback to decide whether an allocated-but-not-released heap node should
 * be reported as a leak. Mirrors memlab's `ILeakFilter.leakFilter` signature
 * so users can reuse the same shape.
 */
export type LeakFilterFn = (
  node: IHeapNode,
  snapshot: IHeapSnapshot,
  leakedNodeIds: Set<number>,
) => boolean;

export type PlaywrightHeapCapturerOptions = {
  /**
   * Working directory for intermediate snapshot files. Defaults to a fresh
   * directory under the OS temp dir. The caller owns cleanup unless
   * `cleanupOnDispose` is true.
   */
  workDir?: string;
  /** Delete workDir on dispose(). Default: true when workDir is auto-generated. */
  cleanupOnDispose?: boolean;
  /** Repeat count for forced GC cycles before the final snapshot. Default 6. */
  gcRepeat?: number;
  /**
   * Custom leak filter applied during `findLeaks`. Receives every heap
   * object allocated between baseline/target that's still live at final,
   * and returns `true` for objects to report as leaks.
   *
   * Without this, memlab's built-in filter only flags detached DOM / React
   * Fiber nodes — so closure-retained JS state (event listeners, timers,
   * external store subscriptions, module-scope arrays) is silently missed.
   * A retained-size threshold is usually the simplest useful filter:
   * `(node) => node.retainedSize > 100_000`.
   */
  leakFilter?: LeakFilterFn;
};

/**
 * Low-level capturer: attach to a Playwright Page, take baseline/target/final
 * snapshots on demand, then hand them to memlab's leak detector.
 *
 * ```ts
 * const capturer = await PlaywrightHeapCapturer.attach(page);
 * await capturer.snapshot('baseline');
 * await page.click('text=Open');
 * await capturer.snapshot('target');
 * await page.click('text=Close');
 * await capturer.snapshot('final'); // runs full GC first
 * const leaks = await capturer.findLeaks();
 * await capturer.dispose();
 * ```
 */
export default class PlaywrightHeapCapturer {
  private readonly page: PageLike;
  private readonly session: CDPLike;
  private readonly workDir: string;
  private readonly cleanupOnDispose: boolean;
  private readonly gcRepeat: number;
  private readonly leakFilter: LeakFilterFn | undefined;
  private readonly snapshotPaths: Partial<Record<PhaseLabel, string>> = {};
  private disposed = false;

  private constructor(
    page: PageLike,
    session: CDPLike,
    workDir: string,
    cleanupOnDispose: boolean,
    gcRepeat: number,
    leakFilter: LeakFilterFn | undefined,
  ) {
    this.page = page;
    this.session = session;
    this.workDir = workDir;
    this.cleanupOnDispose = cleanupOnDispose;
    this.gcRepeat = gcRepeat;
    this.leakFilter = leakFilter;
  }

  static async attach(
    page: PageLike,
    options: PlaywrightHeapCapturerOptions = {},
  ): Promise<PlaywrightHeapCapturer> {
    const autoDir = options.workDir == null;
    const workDir =
      options.workDir ??
      fs.mkdtempSync(path.join(os.tmpdir(), 'memlab-playwright-'));
    fs.ensureDirSync(workDir);

    const session = await page.context().newCDPSession(page);
    await session.send('HeapProfiler.enable');

    return new PlaywrightHeapCapturer(
      page,
      session,
      workDir,
      options.cleanupOnDispose ?? autoDir,
      options.gcRepeat ?? 6,
      options.leakFilter,
    );
  }

  /**
   * Take a named heap snapshot. For `'final'`, a full GC cycle runs first so
   * memlab's leak detector sees only objects retained past cleanup.
   */
  async snapshot(label: PhaseLabel): Promise<string> {
    this.assertLive();
    if (label === 'final') {
      await forceFullGC(this.session, {repeat: this.gcRepeat});
    }
    const file = path.join(this.workDir, `${label}.heapsnapshot`);
    await writeHeapSnapshot(this.session, file);
    this.snapshotPaths[label] = file;
    return file;
  }

  getSnapshotPath(label: PhaseLabel): string | undefined {
    return this.snapshotPaths[label];
  }

  hasAllSnapshots(): boolean {
    return (
      this.snapshotPaths.baseline != null &&
      this.snapshotPaths.target != null &&
      this.snapshotPaths.final != null
    );
  }

  /**
   * Run memlab leak detection across the captured baseline/target/final
   * snapshots. Throws if any of the three is missing. If a `leakFilter`
   * was passed to `attach()`, it is installed on memlab's global config for
   * the duration of this call and restored afterwards (memlab does not
   * accept a per-call filter through the `findLeaks` API).
   */
  async findLeaks(
    overrides: {leakFilter?: LeakFilterFn} = {},
  ): Promise<ISerializedInfo[]> {
    this.assertLive();
    const {baseline, target, final} = this.snapshotPaths;
    if (!baseline || !target || !final) {
      throw new Error(
        'PlaywrightHeapCapturer.findLeaks requires baseline, target, and final snapshots',
      );
    }
    const reader = SnapshotResultReader.fromSnapshots(baseline, target, final);
    const filter = overrides.leakFilter ?? this.leakFilter;

    if (!filter) {
      return findLeaks(reader, {consoleMode: ConsoleMode.SILENT});
    }

    const externalFilter: ILeakFilter = {leakFilter: filter};
    const prev = memlabConfig.externalLeakFilter;
    memlabConfig.externalLeakFilter = externalFilter;
    try {
      return await findLeaks(reader, {consoleMode: ConsoleMode.SILENT});
    } finally {
      memlabConfig.externalLeakFilter = prev;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.session.send('HeapProfiler.disable');
    } catch {
      // session may already be closed with the page
    }
    if (this.cleanupOnDispose) {
      await fs.remove(this.workDir).catch(() => undefined);
    }
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new Error('PlaywrightHeapCapturer has already been disposed');
    }
  }
}
