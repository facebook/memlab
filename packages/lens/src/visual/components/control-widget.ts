/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import {setVisualizerElement} from '../visual-utils';
import {createToggleButton} from './toggle-button';

export function createControlWidget(
  overlayDiv: HTMLDivElement,
  hideAllRef: {value: boolean},
): HTMLDivElement {
  const controlWidget = document.createElement('div');
  controlWidget.style.position = 'fixed';
  controlWidget.style.top = '50px';
  controlWidget.style.right = '50px';
  controlWidget.style.width = '200px';
  controlWidget.style.height = '36px';
  controlWidget.style.background = 'rgba(0, 0, 0, 0.7)';
  controlWidget.style.border = 'none';
  controlWidget.style.borderRadius = '8px';
  controlWidget.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.3)';
  controlWidget.style.zIndex = '19999';
  controlWidget.style.display = 'flex';
  controlWidget.style.alignItems = 'center';
  controlWidget.style.justifyContent = 'flex-start';
  controlWidget.style.paddingLeft = '10px';
  controlWidget.style.textShadow = 'none';
  controlWidget.style.font = '9px Inter, system-ui, -apple-system, sans-serif';
  controlWidget.id = 'memory-visualization-control-widget';
  setVisualizerElement(controlWidget);

  supportDragging(controlWidget);

  const toggleButton = createToggleButton(overlayDiv, hideAllRef);
  controlWidget.append(toggleButton);

  return controlWidget;
}

function supportDragging(controlWidget: HTMLDivElement) {
  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;

  controlWidget.addEventListener('mousedown', e => {
    isDragging = true;
    offsetX = e.clientX - controlWidget.offsetLeft;
    offsetY = e.clientY - controlWidget.offsetTop;
    controlWidget.style.cursor = 'move';
  });

  document.addEventListener('mousemove', e => {
    if (isDragging) {
      controlWidget.style.left = `${e.clientX - offsetX}px`;
      controlWidget.style.top = `${e.clientY - offsetY}px`;
      controlWidget.style.right = '';
    }
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    controlWidget.style.cursor = 'default';
  });
}
