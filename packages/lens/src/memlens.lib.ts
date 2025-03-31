/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import ReactMemoryScan from './core/react-memory-scan';
import {CreateOptions} from './core/types';
// import { DOMVisualizationExtension } from './extensions/dom-visualization-extension';

export function createReactMemoryScan(
  options: CreateOptions = {},
): ReactMemoryScan {
  return new ReactMemoryScan(options);
  // const memoryScan = new ReactMemoryScan(options);
  // const domVisualizer = new DOMVisualizationExtension(memoryScan);
  // memoryScan.registerExtension(domVisualizer);
  // return memoryScan;
}
