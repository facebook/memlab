/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import {
  RegisterDataUpdateCallback,
  VisualizerData,
} from '../dom-element-visualizer-interactive';
import {createVisualizerElement, debounce} from '../visual-utils';

export function createComponentStackPanel(
  registerDataUpdateCallback: RegisterDataUpdateCallback,
): HTMLDivElement {
  const panel = createVisualizerElement('div') as HTMLDivElement;
  panel.style.width = '100%';
  // Ensure max height is at most 80% of viewport height
  panel.style.maxHeight = '80vh';
  panel.style.background = 'rgba(0, 0, 0, 0.5)';
  panel.style.borderTop = '1px solid rgba(255, 255, 255, 0.1)';
  panel.style.display = 'none';
  panel.style.flexDirection = 'column';
  panel.style.padding = '8px';
  panel.style.boxSizing = 'border-box';
  panel.style.borderRadius = '8px';
  panel.style.overflowY = 'scroll';
  panel.style.overflowX = 'hidden';
  panel.style.textShadow = 'none';
  panel.style.font = '9px Inter, system-ui, -apple-system, sans-serif';
  panel.style.color = 'white';
  panel.id = 'memory-visualization-component-stack-panel';

  let pinned = false;

  panel.addEventListener('mouseenter', () => {
    pinned = true;
  });

  panel.addEventListener('mouseleave', () => {
    pinned = false;
  });

  // Register data update callback to update component stack panel
  registerDataUpdateCallback(
    debounce((data: VisualizerData) => {
      if (pinned) {
        return;
      }
      panel.style.display = data.selectedElementId != null ? 'flex' : 'none';
      panel.innerHTML = '';

      if (
        data.selectedElementId == null ||
        !data.selectedReactComponentStack?.length
      ) {
        return;
      }

      const title = createVisualizerElement('div');
      title.textContent = 'Component Stack:';
      title.style.fontWeight = 'bold';
      title.style.marginBottom = '8px';
      panel.appendChild(title);

      let actualComponentStackLength = 0;
      data.selectedReactComponentStack.forEach((component: string) => {
        const componentDiv = createVisualizerElement('div');
        componentDiv.style.marginBottom = '4px';
        componentDiv.textContent = component;
        panel.appendChild(componentDiv);
        ++actualComponentStackLength;
      });

      if (actualComponentStackLength === 0) {
        title.remove();
      }
    }, 1),
  );

  return panel;
}
