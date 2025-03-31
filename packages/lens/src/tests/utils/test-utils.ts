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
