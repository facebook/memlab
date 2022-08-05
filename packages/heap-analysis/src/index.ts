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

import PluginUtils from './PluginUtils';
export const {
  getDominatorNodes,
  /** @deprecated */
  getHeapFromFile,
  getFullHeapFromFile,
  getSnapshotDirForAnalysis,
  getSnapshotFileForAnalysis,
  loadHeapSnapshot,
  snapshotMapReduce,
  takeNodeFullHeap,
} = PluginUtils;

export type {HeapAnalysisOptions} from './PluginUtils';
export {default as BaseAnalysis} from './BaseAnalysis';
export {default as DetachedDOMElementAnalysis} from './plugins/DetachedDOMElementAnalysis';
export {default as GlobalVariableAnalysis} from './plugins/GlobalVariableAnalysis/GlobalVariableAnalysis';
export {default as CollectionsHoldingStaleAnalysis} from './plugins/CollectionsHoldingStaleAnalysis';
export {default as ObjectShallowAnalysis} from './plugins/ObjectShallowAnalysis';
export {default as ObjectSizeAnalysis} from './plugins/ObjectSizeAnalysis';
export {default as ShapeUnboundGrowthAnalysis} from './plugins/ShapeUnboundGrowthAnalysis';
export {default as ObjectFanoutAnalysis} from './plugins/ObjectFanoutAnalysis';
export {default as ObjectShapeAnalysis} from './plugins/ObjectShapeAnalysis';
export {default as ObjectUnboundGrowthAnalysis} from './plugins/ObjectUnboundGrowthAnalysis';
export {default as StringAnalysis} from './plugins/StringAnalysis';
/** @internal */
export {default as PluginUtils} from './PluginUtils';
/** @internal */
export {default as heapAnalysisLoader} from './HeapAnalysisLoader';
/** @internal */
export {default as heapConfig} from './HeapConfig';
