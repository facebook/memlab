/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */
import path from 'path';
import {PackageInfoLoader} from '@memlab/core';
/** @internal */
export async function registerPackage(): Promise<void> {
  return PackageInfoLoader.registerPackage(path.join(__dirname, '..'));
}

export * from '@memlab/api';
