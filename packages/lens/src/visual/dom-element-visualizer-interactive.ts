/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type {DOMElementInfo, AnyValue} from '../core/types';
import DOMElementVisualizer from './dom-element-visualizer';
import {setVisualizerElement} from './visual-utils';

type ElementVisualizer = {
  elementInfo: DOMElementInfo;
  visualizerElementRef: WeakRef<Element>;
};

export default class DOMElementVisualizerInteractive extends DOMElementVisualizer {
  #elementIdToRectangle: Map<number, ElementVisualizer>;
  #visualizationOverlayDiv: HTMLDivElement;
  #selectedElementId: number | null;
  #blockedElementIds: Set<number>;

  constructor() {
    super();
    this.#visualizationOverlayDiv = this.#initOverlayDiv();
    this.#elementIdToRectangle = new Map();
    this.#selectedElementId = null;
    this.#blockedElementIds = new Set();
    this.#listenToKeyboardEvent();
  }

  #listenToKeyboardEvent() {
    document.addEventListener('keydown', event => {
      if (event.key === 'd' || event.key === 'D') {
        if (this.#selectedElementId != null) {
          this.#blockedElementIds.add(this.#selectedElementId);
        }
      }
    });
  }

  #tryToAttachOverlay(overlayDiv: HTMLDivElement) {
    if (document.body) {
      document.body.appendChild(overlayDiv);
    }
  }

  #initOverlayDiv(): HTMLDivElement {
    const overlayDiv = document.createElement('div');
    overlayDiv.id = 'memory-visualization-overlay';
    setVisualizerElement(overlayDiv);
    this.#tryToAttachOverlay(overlayDiv);
    return overlayDiv;
  }

  #getElementIdSet(domElementInfoList: Array<DOMElementInfo>): Set<number> {
    const elementIdSet = new Set<number>();
    for (const info of domElementInfoList) {
      const element = info.element.deref() as AnyValue;
      if (element == null) {
        continue;
      }
      const elementId = element.detachedElementId;
      if (elementId == null) {
        continue;
      }
      elementIdSet.add(elementId);
    }
    return elementIdSet;
  }

  #removeVisualizerElement(elementId: number) {
    const visualizer = this.#elementIdToRectangle.get(elementId);
    this.#elementIdToRectangle.delete(elementId);
    if (visualizer == null) {
      return;
    }
    const visualizerElement = visualizer.visualizerElementRef.deref();
    if (visualizerElement == null) {
      return;
    }
    visualizerElement.remove();
  }

  #cleanup(domElementInfoList: Array<DOMElementInfo>) {
    // first pass remove all those painted visualizer for elements
    // that either 1) is GCed or 2) is connected to the DOM tree
    for (const [
      elementId,
      elementVistualizer,
    ] of this.#elementIdToRectangle.entries()) {
      if (elementId == null) {
        continue;
      }
      const element = elementVistualizer.elementInfo.element.deref();
      if (element == null || element?.isConnected) {
        this.#removeVisualizerElement(elementId);
      }
    }

    const willPaintElementIdSet = this.#getElementIdSet(domElementInfoList);
    for (const [elementId] of this.#elementIdToRectangle.entries()) {
      if (elementId == null) {
        continue;
      }
      if (
        willPaintElementIdSet.has(elementId) &&
        !this.#blockedElementIds.has(elementId)
      ) {
        continue;
      }
      this.#removeVisualizerElement(elementId);
    }
  }

  #paint(domElementInfoList: Array<DOMElementInfo>) {
    for (const info of domElementInfoList) {
      const element = info.element.deref() as AnyValue;
      if (element == null) {
        continue;
      }
      const elementId = element.detachedElementId;
      if (elementId == null) {
        continue;
      }
      if (this.#blockedElementIds.has(elementId)) {
        continue;
      }
      if (this.#elementIdToRectangle.has(elementId)) {
        continue;
      }
      if (element == null) {
        continue;
      }
      if (element.isConnected) {
        continue;
      }
      const visualizerElementRef = this.#overlayRectangle(elementId, info);
      if (
        visualizerElementRef == null ||
        visualizerElementRef.deref() == null
      ) {
        return null;
      }
      const visualizer = {
        elementInfo: info,
        visualizerElementRef,
      };
      this.#elementIdToRectangle.set(elementId, visualizer);
    }
  }

  #overlayRectangle(
    elementId: number,
    info: DOMElementInfo,
  ): WeakRef<Element> | null {
    const rect = info.boundingRect;
    if (rect == null) {
      return null;
    }
    const div = document.createElement('div');
    setVisualizerElement(div);
    div.style.position = 'absolute';
    div.style.width = `${rect.width}px`;
    div.style.height = `${rect.height}px`;
    div.style.top = `${rect.top}px`;
    div.style.left = `${rect.left}px`;
    div.style.border = '1px dashed rgba(75, 192, 192, 0.8)';
    // div.style.pointerEvents = "none"; // Ensures it doesn't interfere with UI interactions

    // append label div to visualizer div
    const labelDiv = document.createElement('div');
    labelDiv.style.font = '9px Inter, system-ui, -apple-system, sans-serif';
    labelDiv.style.display = 'none';
    div.appendChild(labelDiv);
    const componentName = info.component ?? '';
    const elementIdStr = `memory-id-${elementId}@`;
    labelDiv.textContent = `${componentName} (${elementIdStr})`;

    // label div text effect
    labelDiv.style.color = 'black'; // Set text color to black
    labelDiv.style.textShadow = '0 0 4px white, 0 0 6px white'; // Adjust glow effect
    setVisualizerElement(labelDiv);

    const divRef = new WeakRef(div);
    const labelDivRef = new WeakRef(labelDiv);

    this.#attachEventListenersToVisualizer(divRef, labelDivRef, elementId);

    this.#visualizationOverlayDiv.appendChild(div);
    return divRef;
  }

  #attachEventListenersToVisualizer(
    divRef: WeakRef<HTMLDivElement>,
    labelDivRef: WeakRef<HTMLDivElement>,
    elementId: number,
  ) {
    // event listeners
    divRef.deref()?.addEventListener('mouseover', () => {
      const labelDiv = labelDivRef.deref();
      if (labelDiv) {
        labelDiv.style.display = 'block';
      }
      // select the current element
      this.#selectedElementId = elementId;
    });
    divRef.deref()?.addEventListener('mouseout', () => {
      const labelDiv = labelDivRef.deref();
      if (labelDiv) {
        labelDiv.style.display = 'none';
      }
      if (this.#selectedElementId === elementId) {
        this.#selectedElementId = null;
      }
    });
  }

  repaint(domElementInfoList: Array<DOMElementInfo>) {
    this.#visualizationOverlayDiv.remove();
    this.#cleanup(domElementInfoList);
    this.#paint(domElementInfoList);
    this.#tryToAttachOverlay(this.#visualizationOverlayDiv);
  }
}
