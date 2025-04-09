/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type {AnyValue} from '../../core/types';
import {test, expect} from '@playwright/test';
import {libBundleFilePath} from '../utils/test-utils';

test('test library in browser via addScriptTag', async ({page}) => {
  // Navigate to an empty page (or a test page)
  await page.goto('about:blank');

  // Inject the lib bundle file (UMD bundle of the library) into the page
  await page.addScriptTag({path: libBundleFilePath});

  // Now the global `MemLens` should be available in the page
  const libraryLoaded = await page.evaluate(() => {
    const createReactMemoryScan = (window as AnyValue).MemLens
      .createReactMemoryScan;
    const instance = createReactMemoryScan();
    const analysisResult = instance.scan();
    return typeof analysisResult.totalElements === 'number';
  });

  expect(libraryLoaded).toBe(true);
});
