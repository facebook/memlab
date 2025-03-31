/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
const VISUALIZER_DATA_ATTR = 'data-visualizer';

export function setVisualizerElement(element: Element) {
  element.setAttribute(VISUALIZER_DATA_ATTR, 'true');
}

export function isVisualizerElement(element: Element): boolean {
  return element.getAttribute(VISUALIZER_DATA_ATTR) === 'true';
}
