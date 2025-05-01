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
import {DOMVisualizationExtension} from './extensions/dom-visualization-extension';
import {hasRunInSession, setRunInSession} from './utils/utils';

if (!hasRunInSession()) {
  const memoryScan = new ReactMemoryScan({isDevMode: true});
  const domVisualizer = new DOMVisualizationExtension(memoryScan);
  memoryScan.registerExtension(domVisualizer);

  memoryScan.start();
  setRunInSession();
}
