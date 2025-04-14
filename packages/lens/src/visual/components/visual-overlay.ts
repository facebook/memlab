/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import {createVisualizerElement} from '../visual-utils';

export function createOverlayDiv(): HTMLDivElement {
  const overlayDiv = createVisualizerElement('div') as HTMLDivElement;
  overlayDiv.style.position = 'absolute';
  overlayDiv.style.top = '0px';
  overlayDiv.style.left = '0px';
  overlayDiv.id = 'memory-visualization-overlay';
  return overlayDiv;
}

export function tryToAttachOverlay(overlayDiv: HTMLDivElement) {
  if (document.body) {
    document.body.appendChild(overlayDiv);
  }
}
