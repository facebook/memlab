/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type {DOMElementInfo, AnyValue, Optional, Nullable} from '../core/types';
import DOMElementVisualizer from './dom-element-visualizer';
import {
  createOverlayDiv,
  tryToAttachOverlay,
} from './components/visual-overlay';
import {createControlWidget} from './components/control-widget';
import {createOverlayRectangle} from './components/overlay-rectangle';
import {getDOMElementCount} from '../utils/utils';

type ElementVisualizer = {
  elementInfo: DOMElementInfo;
  visualizerElementRef: WeakRef<Element>;
};

export type VisualizerData = {
  detachedDOMElementsCount: number;
  totalDOMElementsCount: number;
  selectedElementId: Nullable<number>;
  selectedReactComponentStack: Array<ElementVisualizer>;
};

export type DateUpdateCallback = (data: VisualizerData) => void;
export type RegisterDataUpdateCallback = (cb: DateUpdateCallback) => void;

export default class DOMElementVisualizerInteractive extends DOMElementVisualizer {
  #elementIdToRectangle: Map<number, ElementVisualizer>;
  #visualizationOverlayDiv: HTMLDivElement;
  #controlWidget: HTMLDivElement;
  #blockedElementIds: Set<number>;
  #currentVisualData: VisualizerData;
  #hideAllRef: {value: boolean};
  #updateDataCallbacks: Array<DateUpdateCallback> = [];

  constructor() {
    super();
    this.#hideAllRef = {value: false};
    this.#visualizationOverlayDiv = createOverlayDiv();
    tryToAttachOverlay(this.#visualizationOverlayDiv);
    this.#controlWidget = createControlWidget(
      this.#visualizationOverlayDiv,
      this.#hideAllRef,
      cb => {
        this.#updateDataCallbacks.push(cb);
      },
    );
    tryToAttachOverlay(this.#controlWidget);
    this.#elementIdToRectangle = new Map();
    this.#currentVisualData = this.#initVisualizerData();
    this.#blockedElementIds = new Set();
    this.#listenToKeyboardEvent();
  }

  #listenToKeyboardEvent() {
    document.addEventListener('keydown', event => {
      if (event.key === 'd' || event.key === 'D') {
        if (this.#currentVisualData.selectedElementId != null) {
          this.#blockedElementIds.add(
            this.#currentVisualData.selectedElementId,
          );
        }
      }
    });
  }

  #initVisualizerData(): VisualizerData {
    return {
      detachedDOMElementsCount: 0,
      totalDOMElementsCount: getDOMElementCount(),
      selectedElementId: null,
      selectedReactComponentStack: [],
    };
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

  #getComponentStackForElement(
    elementId: Optional<number>,
  ): ElementVisualizer[] {
    const ret: ElementVisualizer[] = [];
    if (elementId == null) {
      return ret;
    }
    const visualizer = this.#elementIdToRectangle.get(elementId);
    if (visualizer == null) {
      return ret;
    }
    const element = visualizer.elementInfo.element.deref() as AnyValue;
    if (element == null) {
      return ret;
    }
    // traverse parent elements
    let currentElement: Optional<Element> = element;
    while (currentElement) {
      if (currentElement.isConnected) {
        break;
      }
      const elementId = (currentElement as AnyValue).detachedElementId;
      const info = this.#elementIdToRectangle.get(elementId);
      if (info == null) {
        break;
      }
      ret.push(info);
      currentElement = currentElement.parentElement;
    }
    return ret;
  }

  #traverseUpOutlineElements(
    elementId: number,
    callback: (element: HTMLElement) => void,
  ): void {
    const visualizer = this.#elementIdToRectangle.get(elementId);
    if (visualizer == null) {
      return;
    }
    const visitedElementIds = new Set<number>();
    let currentElement: Optional<Element> =
      visualizer.elementInfo.element.deref();
    while (currentElement) {
      if (currentElement.isConnected) {
        break;
      }
      const elementIdStr = (currentElement as AnyValue).detachedElementId;
      const elementId = parseInt(elementIdStr, 10);
      if (visitedElementIds.has(elementId)) {
        break;
      }
      visitedElementIds.add(elementId);
      const visualizerInfo = this.#elementIdToRectangle.get(elementId);
      if (visualizerInfo == null) {
        break;
      }
      const visualizerElement = visualizerInfo.visualizerElementRef.deref();
      if (visualizerElement == null) {
        break;
      }
      callback(visualizerElement as HTMLElement);
      currentElement = currentElement.parentElement;
    }
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

    // second pass remove all those outlines that won't be painted later
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
    const zIndexBase = 9999;

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
      const zIndex = zIndexBase + parseInt(elementId, 10);
      const visualizerElementRef = createOverlayRectangle(
        elementId,
        info,
        this.#visualizationOverlayDiv,
        (selectedId: number | null) => {
          this.#currentVisualData.selectedElementId = selectedId;
          this.#updateVisualizerData();
          if (selectedId == null) {
            return;
          }
          this.#traverseUpOutlineElements(selectedId, element => {
            element.style.border = '1px solid rgba(75, 192, 192, 0.8)';
            element.style.background = 'rgba(75, 192, 192, 0.02)';
          });
        },
        (unselectedId: number | null) => {
          if (this.#currentVisualData.selectedElementId === unselectedId) {
            this.#currentVisualData.selectedElementId = null;
            this.#updateVisualizerData();
          }
          if (unselectedId == null) {
            return;
          }
          this.#traverseUpOutlineElements(unselectedId, element => {
            element.style.border = '1px dotted rgba(75, 192, 192, 0.8)';
            element.style.background = '';
          });
        },
        zIndex,
      );
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

  #updateVisualizerData() {
    const data = this.#currentVisualData;
    data.detachedDOMElementsCount = this.#elementIdToRectangle.size;
    data.totalDOMElementsCount = getDOMElementCount();
    data.selectedReactComponentStack = this.#getComponentStackForElement(
      data.selectedElementId,
    );
    for (const cb of this.#updateDataCallbacks) {
      cb({...this.#currentVisualData});
    }
  }

  repaint(domElementInfoList: Array<DOMElementInfo>) {
    this.#controlWidget.remove();
    this.#visualizationOverlayDiv.remove();
    this.#cleanup(domElementInfoList);
    this.#paint(domElementInfoList);
    this.#updateVisualizerData();
    tryToAttachOverlay(this.#visualizationOverlayDiv);
    tryToAttachOverlay(this.#controlWidget);
  }
}
