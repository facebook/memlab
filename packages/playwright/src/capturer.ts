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
import type {ISerializedInfo} from '@memlab/core';

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
  private readonly snapshotPaths: Partial<Record<PhaseLabel, string>> = {};
  private disposed = false;

  private constructor(
    page: PageLike,
    session: CDPLike,
    workDir: string,
    cleanupOnDispose: boolean,
    gcRepeat: number,
  ) {
    this.page = page;
    this.session = session;
    this.workDir = workDir;
    this.cleanupOnDispose = cleanupOnDispose;
    this.gcRepeat = gcRepeat;
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
   * snapshots. Throws if any of the three is missing.
   */
  async findLeaks(): Promise<ISerializedInfo[]> {
    this.assertLive();
    const {baseline, target, final} = this.snapshotPaths;
    if (!baseline || !target || !final) {
      throw new Error(
        'PlaywrightHeapCapturer.findLeaks requires baseline, target, and final snapshots',
      );
    }
    const reader = SnapshotResultReader.fromSnapshots(baseline, target, final);
    return findLeaks(reader, {consoleMode: ConsoleMode.SILENT});
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
