/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import path from 'path';
import {PackageInfoLoader} from '@memlab/core';
/** @internal */
export async function registerPackage(): Promise<void> {
  return PackageInfoLoader.registerPackage(path.join(__dirname, '..'));
}

export {default as defaultTestPlanner} from './lib/operations/TestPlanner';
export * from './lib/operations/TestPlanner';
export {default as Xvfb} from './lib/operations/XVirtualFrameBuffer';
export {default as E2EInteractionManager} from './E2EInteractionManager';
export {default as BaseSynthesizer} from './BaseSynthesizer';
export {default as E2EUtils} from './lib/E2EUtils';
/** @internal */
export {default as ScriptManager} from './ScriptManager';
