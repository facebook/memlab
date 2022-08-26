/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import path from 'path';
import {PackageInfoLoader} from './lib/PackageInfoLoader';
/** @internal */
export async function registerPackage(): Promise<void> {
  return PackageInfoLoader.registerPackage(path.join(__dirname, '..'));
}

export * from './lib/Types';
export * from './lib/NodeHeap';
/** @internal */
export {default as config} from './lib/Config';
/** @internal */
export * from './lib/InternalValueSetter';
/** @internal */
export * from './lib/Config';
/** @internal */
export {default as info} from './lib/Console';
/** @internal */
export {default as BaseOption} from './lib/BaseOption';
/** @internal */
export {default as utils} from './lib/Utils';
/** @internal */
export {default as fileManager} from './lib/FileManager';
/** @internal */
export * from './lib/FileManager';
/** @internal */
export {default as serializer} from './lib/Serializer';
/** @internal */
export {default as browserInfo} from './lib/BrowserInfo';
/** @internal */
export {default as analysis} from './lib/HeapAnalyzer';
/** @internal */
export {default as constant} from './lib/Constant';
/** @internal */
export {default as modes} from './modes/RunningModes';
/** @internal */
export {default as ProcessManager} from './lib/ProcessManager';
/** @internal */
export {default as leakClusterLogger} from './logger/LeakClusterLogger';
/** @internal */
export {default as NormalizedTrace} from './trace-cluster/TraceBucket';
/** @internal */
export {default as EvaluationMetric} from './trace-cluster/EvalutationMetric';
/** @internal */
export * from './lib/PackageInfoLoader';
/** @internal */
export {default as SequentialClustering} from './trace-cluster/SequentialClustering';
