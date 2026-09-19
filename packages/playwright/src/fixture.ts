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
import {test as baseTest, expect} from '@playwright/test';
import type {Page, TestInfo} from '@playwright/test';
import type {ISerializedInfo} from '@memlab/core';

import {writeHeapSnapshot, forceFullGC} from './snapshot';
import type {CDPLike} from './snapshot';
import {
  formatLeakMessage,
  isInspectorArtifact,
  runFindLeaks,
  stripInternalKeysReplacer,
} from './leak';
import {PHASE_LABELS} from './types';
import type {
  MemlabConfigInput,
  MemlabFixture,
  PhaseLabel,
} from './types';

/**
 * Playwright `test` with a `memlab` fixture attached. Destructuring
 * `memlab` captures heap snapshots around the test body and runs
 * memlab's leak detector during teardown.
 *
 * @example
 * ```ts
 * import {test, expect} from '@memlab/playwright';
 *
 * test('modal close does not leak', async ({page, memlab}) => {
 *   await page.goto('/');
 *   await memlab.baseline();
 *   await page.click('text=Open');
 *   await page.click('text=Close');
 * });
 * ```
 */
export const test = baseTest.extend<{memlab: MemlabFixture}>({
  memlab: async ({page}, use, testInfo) => {
    const session = await attachCDPSession(page, testInfo);
    if (!session) {
      await use(noopFixture());
      return;
    }

    const workDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'memlab-playwright-'),
    );
    const snapshotPaths: Partial<Record<PhaseLabel, string>> = {};
    let manualVerified = false;
    let cachedLeaks: ISerializedInfo[] | null = null;
    let userConfig: MemlabConfigInput = {};

    const takeSnapshot = async (label: PhaseLabel): Promise<void> => {
      if (label === 'final') {
        await forceFullGC(session, userConfig.gc ?? {});
      }
      const file = path.join(workDir, `${label}.heapsnapshot`);
      await writeHeapSnapshot(session, file);
      snapshotPaths[label] = file;
    };

    const detectLeaks = async (): Promise<ISerializedInfo[]> => {
      const raw = await runFindLeaks(
        snapshotPaths as Record<PhaseLabel, string>,
        userConfig.leakFilter,
      );
      return raw.filter(l => !isInspectorArtifact(l));
    };

    const captureAndDetect = async (): Promise<ISerializedInfo[]> => {
      if (!snapshotPaths.target) await takeSnapshot('target');
      if (!snapshotPaths.final) await takeSnapshot('final');
      cachedLeaks = await detectLeaks();
      return cachedLeaks;
    };

    const fixture: MemlabFixture = {
      mark: takeSnapshot,
      baseline: () => takeSnapshot('baseline'),
      target: () => takeSnapshot('target'),
      final: () => takeSnapshot('final'),
      configure: config => {
        userConfig = {
          ...userConfig,
          ...config,
          gc: config.gc ? {...userConfig.gc, ...config.gc} : userConfig.gc,
        };
      },
      findLeaks: async () => {
        manualVerified = true;
        if (!snapshotPaths.baseline) return null;
        return captureAndDetect();
      },
      expectNoLeaks: async () => {
        manualVerified = true;
        if (!snapshotPaths.baseline) {
          throw new Error(
            'memlab.expectNoLeaks(): call memlab.baseline() before the ' +
              'leak-inducing interaction.',
          );
        }
        const leaks = await captureAndDetect();
        if (leaks.length > 0) {
          throw new Error(formatLeakMessage(leaks));
        }
      },
    };

    try {
      await use(fixture);
    } finally {
      try {
        if (!manualVerified) {
          for (const label of PHASE_LABELS) {
            if (!snapshotPaths[label]) await takeSnapshot(label);
          }
          cachedLeaks = await detectLeaks();
        }
        if (
          cachedLeaks != null &&
          cachedLeaks.length > 0 &&
          allPhasesCaptured(snapshotPaths)
        ) {
          await attachArtifacts(testInfo, cachedLeaks, snapshotPaths);
        }
        if (!manualVerified && cachedLeaks != null && cachedLeaks.length > 0) {
          expect
            .soft(cachedLeaks.length, formatLeakMessage(cachedLeaks))
            .toBe(0);
        }
      } finally {
        await closeSession(session);
        await fs.remove(workDir).catch(() => undefined);
      }
    }
  },
});

export {expect};
export type {Page};

async function attachCDPSession(
  page: Page,
  testInfo: TestInfo,
): Promise<CDPLike | null> {
  try {
    const raw = await page.context().newCDPSession(page);
    const session = raw as unknown as CDPLike;
    await session.send('HeapProfiler.enable');
    return session;
  } catch (err) {
    testInfo.annotations.push({
      type: 'memlab-skip',
      description: `memlab requires Chromium CDP (got: ${
        (err as Error).message
      })`,
    });
    return null;
  }
}

async function closeSession(session: CDPLike): Promise<void> {
  try {
    await session.send('HeapProfiler.disable');
  } catch {
    // session may already be closed with the page
  }
}

function allPhasesCaptured(
  paths: Partial<Record<PhaseLabel, string>>,
): paths is Record<PhaseLabel, string> {
  return PHASE_LABELS.every(label => paths[label] != null);
}

async function attachArtifacts(
  testInfo: TestInfo,
  leaks: ISerializedInfo[],
  paths: Record<PhaseLabel, string>,
): Promise<void> {
  const reportPath = testInfo.outputPath('memlab-leaks.json');
  await fs.outputJson(reportPath, leaks, {
    spaces: 2,
    replacer: stripInternalKeysReplacer,
  });
  await Promise.all([
    testInfo.attach('memlab-leaks', {
      path: reportPath,
      contentType: 'application/json',
    }),
    ...PHASE_LABELS.map(label =>
      testInfo.attach(`${label}.heapsnapshot`, {
        path: paths[label],
        contentType: 'application/octet-stream',
      }),
    ),
  ]);
}

function noopFixture(): MemlabFixture {
  return {
    mark: async () => undefined,
    baseline: async () => undefined,
    target: async () => undefined,
    final: async () => undefined,
    configure: () => undefined,
    findLeaks: async () => null,
    expectNoLeaks: async () => undefined,
  };
}
