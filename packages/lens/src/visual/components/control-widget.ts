/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import {RegisterDataUpdateCallback} from '../dom-element-visualizer-interactive';
import {createVisualizerElement} from '../visual-utils';
import {createStatusText} from './status-text';
import {createToggleButton} from './toggle-button';
import {createComponentStackPanel} from './component-stack-panel';

export function createControlWidget(
  overlayDiv: HTMLDivElement,
  hideAllRef: {value: boolean},
  registerDataUpdateCallback: RegisterDataUpdateCallback,
): HTMLDivElement {
  const controlWidget = createVisualizerElement('div') as HTMLDivElement;
  controlWidget.style.position = 'fixed';
  controlWidget.style.top = '50px';
  controlWidget.style.right = '50px';
  controlWidget.style.width = '400px';
  controlWidget.style.background = 'rgba(0, 0, 0, 0.7)';
  controlWidget.style.border = 'none';
  controlWidget.style.borderRadius = '8px';
  controlWidget.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.3)';
  controlWidget.style.zIndex = '999999999';
  controlWidget.style.display = 'flex';
  controlWidget.style.flexDirection = 'column';
  controlWidget.style.textShadow = 'none';
  controlWidget.style.boxSizing = 'border-box';
  controlWidget.style.font = '9px Inter, system-ui, -apple-system, sans-serif';
  controlWidget.id = 'memory-visualization-control-widget';

  // Create header section
  const header = createVisualizerElement('div') as HTMLDivElement;
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.justifyContent = 'flex-start';
  header.style.padding = '0 8px';
  header.style.height = '36px';
  controlWidget.appendChild(header);

  // Create component stack panel
  const componentStackPanel = createComponentStackPanel(
    registerDataUpdateCallback,
  );
  controlWidget.appendChild(componentStackPanel);

  supportDragging(controlWidget);

  const toggleButton = createToggleButton(overlayDiv, hideAllRef);
  header.appendChild(toggleButton);

  const statusText = createStatusText(registerDataUpdateCallback);
  header.appendChild(statusText);

  return controlWidget;
}

function supportDragging(controlWidget: HTMLDivElement) {
  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;

  controlWidget.addEventListener('mousedown', e => {
    // Only allow dragging from the header
    if (
      !(e.target as HTMLElement).closest(
        '#memory-visualization-control-widget > div:first-child',
      )
    ) {
      return;
    }
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
