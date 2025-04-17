/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type {DOMElementInfo, Nullable, AnyValue} from '../core/types';
import {createVisualizerElement} from './visual-utils';

export default class DOMElementVisualizer {
  #canvas: Nullable<HTMLCanvasElement>;
  constructor() {
    this.#canvas = null;
  }

  #paint(domElementInfoList: Array<DOMElementInfo>) {
    if (!this.#canvas) {
      const canvas = this.#createAndAppendCanvas();
      this.#canvas = canvas;
    }
    this.#paintRectangles(domElementInfoList);
  }

  #cleanupExistingCanvas() {
    // Clean up any existing canvas
    if (this.#canvas) {
      const ctx = this.#canvas.getContext('2d');
      ctx?.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
      this.#canvas.remove();
      this.#canvas = null;
    }
  }

  #tryToAttachCanvas(canvas: Element) {
    if (document.body) {
      document.body.appendChild(canvas);
    }
  }

  #createAndAppendCanvas() {
    // Create and insert the canvas element
    const canvas = createVisualizerElement('canvas') as HTMLCanvasElement;
    canvas.id = 'overlayCanvas';
    this.#tryToAttachCanvas(canvas);

    // Style the canvas to cover the entire page
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '99999';

    // Set canvas dimensions to match the window dimensions
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    return canvas;
  }

  #paintKey(info: DOMElementInfo): string {
    const {boundingRect} = info;
    return JSON.stringify({boundingRect});
  }

  #paintRectangles(domElementInfoList: Array<DOMElementInfo>) {
    const canvas = this.#canvas;
    if (!canvas) {
      return;
    }
    // Get the 2D drawing context
    const ctx = canvas.getContext('2d');
    if (ctx == null) {
      return;
    }

    // Set rectangle styles
    ctx.strokeStyle = 'rgba(75, 192, 192, 0.8)';
    ctx.lineWidth = 2;
    ctx.fillStyle = 'rgba(75, 192, 192, 0.05)';
    ctx.font = '11px Inter, system-ui, -apple-system, sans-serif';

    const paintedInfo = new Set<string>();

    // Draw the rectangles
    domElementInfoList.forEach((info: DOMElementInfo) => {
      const rect = info.boundingRect;
      if (rect == null) {
        return;
      }
      const key = this.#paintKey(info);
      if (paintedInfo.has(key)) {
        return;
      }
      paintedInfo.add(key);
      ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
      ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);

      const component = info.componentStack?.[0];
      if (component) {
        // attach detached element id key so that it is easy to search in heap snapshot
        const element = info.element.deref() as AnyValue;
        const elementId = element?.detachedElementId;
        const elementIdText = elementId ? ` (${elementId})` : '';
        const text = `${component}${elementIdText}`;
        ctx.fillStyle = 'rgba(74, 131, 224, 1)';
        ctx.fillText(text, rect.left + 5, rect.top + 15); // Draw the name
        ctx.fillStyle = 'rgba(75, 192, 192, 0.05)';
      }
    });
  }

  #cleanup() {
    const canvas = this.#canvas;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.parentNode?.removeChild(canvas);
    }
    this.#canvas = null;
  }

  repaint(domElementInfoList: Array<DOMElementInfo>) {
    this.#cleanup();
    this.#paint(domElementInfoList);
  }
}
