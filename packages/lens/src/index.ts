/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import * as fs from 'fs';
import * as path from 'path';

export function getBundleContent(): string {
  const bundlePath = path.join(__dirname, 'memlens.run.bundle.min.js');
  return fs.readFileSync(bundlePath, {encoding: 'utf8'});
}
