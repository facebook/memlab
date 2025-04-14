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
import {createVisualizerElement} from '../visual-utils';

export function createComponentStackPanel(
  registerDataUpdateCallback: RegisterDataUpdateCallback,
): HTMLDivElement {
  const panel = createVisualizerElement('div') as HTMLDivElement;
  panel.style.width = '100%';
  panel.style.maxHeight = '2000px';
  // panel.style.background = 'rgba(0, 0, 0, 0.5)';
  panel.style.borderTop = '1px solid rgba(255, 255, 255, 0.1)';
  panel.style.display = 'none';
  panel.style.flexDirection = 'column';
  panel.style.padding = '8px 8px 0 8px';
  panel.style.boxSizing = 'border-box';
  panel.style.borderRadius = '8px';
  panel.style.overflowY = 'auto';
  panel.style.textShadow = 'none';
  panel.style.font = '9px Inter, system-ui, -apple-system, sans-serif';
  panel.style.color = 'white';
  panel.id = 'memory-visualization-component-stack-panel';

  // Register data update callback to update component stack panel
  registerDataUpdateCallback((data: VisualizerData) => {
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
    data.selectedReactComponentStack.forEach(visualizer => {
      const component = visualizer.elementInfo.component;
      if (!component) {
        return;
      }
      const tagName = visualizer.visualizerElementRef
        .deref()
        ?.tagName?.toLocaleLowerCase();
      const componentDiv = createVisualizerElement('div');
      componentDiv.style.marginBottom = '4px';
      componentDiv.textContent = `${component} (${tagName})`;
      panel.appendChild(componentDiv);
      ++actualComponentStackLength;
    });

    if (actualComponentStackLength === 0) {
      title.remove();
    }
  });

  return panel;
}
