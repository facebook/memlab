/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type {AnyValue, DOMElementInfo} from '../../core/types';
import {IntersectionObserverManager} from '../../utils/intersection-observer';
import {createVisualizerElement} from '../visual-utils';

const MAX_Z_INDEX = `${Math.pow(2, 30) - 1}`;

// Set up intersection observer
const observerManager = IntersectionObserverManager.getInstance();

export function createOverlayRectangle(
  elementId: number,
  info: DOMElementInfo,
  container: HTMLDivElement,
  setSelectedId: (id: number | null) => void,
  setUnSelectedId: (id: number | null) => void,
  zIndex: number,
): WeakRef<Element> | null {
  const rect = info.boundingRect;
  if (!rect) return null;

  const div = createVisualizerElement('div') as HTMLDivElement;
  div.style.position = 'absolute';
  div.style.width = `${rect.width}px`;
  div.style.height = `${rect.height}px`;
  div.style.top = `${rect.top + rect.scrollTop}px`;
  div.style.left = `${rect.left + rect.scrollLeft}px`;
  div.style.border = '1px dotted rgba(75, 192, 192, 0.8)';
  div.style.borderRadius = '1px';
  div.style.zIndex = zIndex.toString();

  const labelDiv = createVisualizerElement('div');
  const componentStack = info.componentStack ?? [];
  const componentName = componentStack[0] ?? '';
  const elementIdStr = `memory-id-${elementId}@`;
  labelDiv.textContent = `${componentName} (${elementIdStr})`;

  labelDiv.style.color = 'white';
  labelDiv.style.background = 'rgba(75, 192, 192, 0.8)';
  labelDiv.style.textShadow = 'none';
  labelDiv.style.font = '9px Inter, system-ui, -apple-system, sans-serif';
  labelDiv.style.padding = '2px 6px';
  labelDiv.style.borderRadius = '2px';
  labelDiv.style.width = 'auto';
  labelDiv.style.height = 'auto';
  labelDiv.style.display = 'none';
  labelDiv.style.zIndex = MAX_Z_INDEX;

  div.appendChild(labelDiv);

  const divRef = new WeakRef(div);
  const labelDivRef = new WeakRef(labelDiv);

  div.addEventListener('mouseover', () => {
    const label = labelDivRef.deref();
    if (label) {
      label.style.display = 'inline-block';
    }
    setSelectedId(elementId);
  });

  div.addEventListener('mouseout', () => {
    const label = labelDivRef.deref();
    if (label) label.style.display = 'none';
    setUnSelectedId(elementId);
  });

  observerManager.observe(div, (entry: IntersectionObserverEntry) => {
    if (!entry.isIntersecting) {
      div.style.visibility = 'hidden';
    } else {
      div.style.visibility = 'visible';
    }
  });

  (div as AnyValue).__cleanup = () => {
    observerManager.unobserve(div);
    (div as AnyValue).__cleanup = null;
  };

  container.appendChild(div);
  return divRef;
}
