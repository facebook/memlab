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

type OutlineState = {pinned: boolean; selected: boolean};

const MAX_Z_INDEX = `${Math.pow(2, 30) - 1}`;

// Set up intersection observer
const observerManager = IntersectionObserverManager.getInstance();

function createLabelDiv(): HTMLElement {
  const labelDiv = createVisualizerElement('div');

  labelDiv.style.color = 'white';
  labelDiv.style.background = 'rgba(75, 192, 192, 0.8)';
  labelDiv.style.textShadow = 'none';
  labelDiv.style.font = '9px Inter, system-ui, -apple-system, sans-serif';
  labelDiv.style.padding = '2px 6px';
  labelDiv.style.borderRadius = '2px';
  labelDiv.style.whiteSpace = 'nowrap'; // Force single-line text
  labelDiv.style.position = 'absolute'; // Allows positioning above parent
  labelDiv.style.bottom = '100%'; // Places it just above the parent
  labelDiv.style.left = '0'; // Align left with parent
  labelDiv.style.marginBottom = '2px'; // Small space between label and parent
  labelDiv.style.display = 'none';
  labelDiv.style.zIndex = MAX_Z_INDEX;

  return labelDiv;
}

const labelDiv = createLabelDiv();

export function createOverlayRectangle(
  elementId: number,
  info: DOMElementInfo,
  container: HTMLDivElement,
  setSelectedId: (id: number | null) => void,
  setUnSelectedId: (id: number | null) => void,
  setClickedId: (id: number | null) => void,
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

  const componentStack = info.componentStack ?? [];
  const componentName = componentStack[0] ?? '';
  const elementIdStr = `memory-id-${elementId}@`;

  let pinned = false;
  let selected = false;

  const divRef = new WeakRef(div);

  div.addEventListener('mouseover', () => {
    labelDiv.remove();
    div.appendChild(labelDiv);
    labelDiv.textContent = `${componentName} (${elementIdStr})`;
    labelDiv.style.display = 'inline-block';
    setSelectedId(elementId);
  });

  div.addEventListener('mouseout', () => {
    labelDiv.style.display = 'none';
    labelDiv.remove();
    setUnSelectedId(elementId);
  });

  div.addEventListener('click', () => {
    setClickedId(elementId);
  });

  (div as AnyValue).__selected = () => {
    selected = true;
    styleOnInteraction(divRef, {selected, pinned});
  };

  (div as AnyValue).__unselected = () => {
    selected = false;
    styleOnInteraction(divRef, {selected, pinned});
  };

  (div as AnyValue).__pinned = () => {
    pinned = true;
    styleOnInteraction(divRef, {selected, pinned});
  };

  (div as AnyValue).__unpinned = () => {
    pinned = false;
    styleOnInteraction(divRef, {selected, pinned});
  };

  observerManager.observe(divRef, (entry: IntersectionObserverEntry) => {
    if (!entry.isIntersecting) {
      div.style.visibility = 'hidden';
    } else {
      div.style.visibility = 'visible';
    }
  });

  (div as AnyValue).__cleanup = () => {
    const div = divRef.deref();
    if (div == null) {
      return;
    }
    observerManager.unobserve(divRef);
    (div as AnyValue).__cleanup = null;
    (div as AnyValue).__selected = null;
    (div as AnyValue).__unselected = null;
    (div as AnyValue).__pinned = null;
    (div as AnyValue).__unpinned = null;
  };

  container.appendChild(div);
  return divRef;
}

function styleOnInteraction(
  divRef: WeakRef<HTMLDivElement>,
  state: OutlineState,
): void {
  const div = divRef.deref();
  if (div == null) {
    return;
  }
  const {pinned, selected} = state;
  if (!pinned) {
    if (selected) {
      div.style.border = '1px solid rgba(75, 192, 192, 0.8)';
      div.style.background = 'rgba(75, 192, 192, 0.02)';
    } else {
      div.style.border = '1px dotted rgba(75, 192, 192, 0.8)';
      div.style.background = '';
    }
  } else {
    // pinned
    div.style.border = '1px solid rgba(255, 215, 0, 0.9)';
    div.style.background = 'rgba(255, 215, 0, 0.08)';
  }
}
