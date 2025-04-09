/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import path from 'path';

// export a function that returns the absolute path to the dist folder

export const distPath = path.join(__dirname, '..', '..', '..', 'dist');
export const srcPath = path.join(__dirname, '..', '..', '..', 'src');

export async function wait(timeoutInMs: number) {
  await new Promise(resolve => setTimeout(resolve, timeoutInMs));
}

export const libBundleFile = 'memlens.lib.bundle.js';
export const libBundleFilePath = path.join(distPath, libBundleFile);
export const libBundleMinFile = 'memlens.lib.bundle.min.js';
export const libBundleMinFilePath = path.join(distPath, libBundleMinFile);
export const runBundleFile = 'memlens.run.bundle.js';
export const runBundleFilePath = path.join(distPath, runBundleFile);
export const runBundleMinFile = 'memlens.run.bundle.min.js';
export const runBundleMinFilePath = path.join(distPath, runBundleMinFile);
