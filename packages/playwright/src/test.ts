/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import fs from 'fs-extra';
import {test as baseTest, expect} from '@playwright/test';
import type {Page} from '@playwright/test';
import type {ISerializedInfo} from '@memlab/core';

import PlaywrightHeapCapturer, {PageLike, PhaseLabel} from './capturer';

export type MemlabFixture = {
  /**
   * Capture a named heap snapshot. For `'final'`, a full GC cycle runs first.
   * Overrides the automatic snapshot that would otherwise be taken for that
   * phase.
   */
  mark(label: PhaseLabel): Promise<void>;
  baseline(): Promise<void>;
  target(): Promise<void>;
  final(): Promise<void>;
  /** Returns the leak report, or null if snapshots are incomplete. */
  findLeaks(): Promise<ISerializedInfo[] | null>;
};

type PhaseState = {
  baseline: boolean;
  target: boolean;
  final: boolean;
};

/**
 * Drop-in replacement for `@playwright/test`'s `test`. Destructuring
 * `memlab` in the test body enables heap capture + leak analysis for that
 * test; omitting it leaves the test untouched.
 *
 * ```ts
 * import { test, expect } from '@memlab/playwright/test';
 *
 * test('modal close does not leak', async ({ page, memlab }) => {
 *   await page.goto('/');
 *   await memlab.baseline();
 *   await page.click('text=Open');
 *   await page.click('text=Close');
 * });
 * ```
 */
export const test = baseTest.extend<{memlab: MemlabFixture}>({
  memlab: async ({page}, use, testInfo) => {
    let capturer: PlaywrightHeapCapturer;
    try {
      capturer = await PlaywrightHeapCapturer.attach(page as PageLike);
    } catch (err) {
      // Non-Chromium browsers cannot create a CDP session. Surface the
      // reason as a test annotation and provide a no-op fixture so the
      // rest of the test can run unchanged.
      testInfo.annotations.push({
        type: 'memlab-skip',
        description: `memlab requires Chromium CDP (got: ${
          (err as Error).message
        })`,
      });
      const noop: MemlabFixture = {
        mark: async () => undefined,
        baseline: async () => undefined,
        target: async () => undefined,
        final: async () => undefined,
        findLeaks: async () => null,
      };
      await use(noop);
      return;
    }

    const manual: PhaseState = {baseline: false, target: false, final: false};
    const mark = async (label: PhaseLabel) => {
      await capturer.snapshot(label);
      manual[label] = true;
    };

    const fixture: MemlabFixture = {
      mark,
      baseline: () => mark('baseline'),
      target: () => mark('target'),
      final: () => mark('final'),
      findLeaks: async () =>
        capturer.hasAllSnapshots() ? capturer.findLeaks() : null,
    };

    try {
      await use(fixture);
    } finally {
      try {
        // Auto fallback for any phase the user did not mark. Baseline is
        // the fragile one — if it wasn't captured before the action, the
        // snapshot taken here reflects post-action state and the
        // comparison is degenerate. Users should call
        // `await memlab.baseline()` explicitly after navigation.
        if (!manual.baseline && !capturer.getSnapshotPath('baseline')) {
          await capturer.snapshot('baseline');
        }
        if (!manual.target) {
          await capturer.snapshot('target');
        }
        if (!manual.final) {
          await capturer.snapshot('final');
        }

        if (capturer.hasAllSnapshots()) {
          const leaks = await capturer.findLeaks();
          const reportPath = testInfo.outputPath('memlab-leaks.json');
          await fs.outputJson(reportPath, leaks, {spaces: 2});
          await testInfo.attach('memlab-leaks', {
            path: reportPath,
            contentType: 'application/json',
          });
          // Preserve the raw snapshots so users can open them in Chrome
          // DevTools → Memory → Load.
          for (const label of ['baseline', 'target', 'final'] as PhaseLabel[]) {
            const src = capturer.getSnapshotPath(label);
            if (!src) continue;
            const dest = testInfo.outputPath(`${label}.heapsnapshot`);
            await fs.copy(src, dest);
            await testInfo.attach(`${label}.heapsnapshot`, {
              path: dest,
              contentType: 'application/octet-stream',
            });
          }
          if (leaks.length > 0) {
            const summary = leaks
              .slice(0, 5)
              .map((l, i) => `  #${i + 1}: ${leakSummary(l)}`)
              .join('\n');
            const msg =
              `memlab detected ${leaks.length} leak trace(s):\n${summary}` +
              (leaks.length > 5 ? `\n  ... and ${leaks.length - 5} more` : '');
            expect.soft(leaks, msg).toHaveLength(0);
          }
        }
      } finally {
        await capturer.dispose();
      }
    }
  },
});

function leakSummary(leak: ISerializedInfo): string {
  const maybe = leak as unknown as {
    retainedSize?: number;
    type?: string;
    name?: string;
  };
  const parts: string[] = [];
  if (maybe.type) parts.push(maybe.type);
  if (maybe.name) parts.push(maybe.name);
  if (typeof maybe.retainedSize === 'number')
    parts.push(`${maybe.retainedSize}B retained`);
  return parts.join(' · ') || 'leak';
}

export {expect};
export type {Page};
