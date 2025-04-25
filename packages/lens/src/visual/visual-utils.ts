/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type {AnyValue} from '../core/types';

const VISUALIZER_DATA_ATTR = 'data-visualizer';

function setVisualizerElement(element: Element) {
  element.setAttribute(VISUALIZER_DATA_ATTR, 'true');
  element.setAttribute('data-visualcompletion', 'ignore');
}

export function isVisualizerElement(element: Element): boolean {
  return element.getAttribute(VISUALIZER_DATA_ATTR) === 'true';
}

export function createVisualizerElement(tag: string): HTMLElement {
  const element = document.createElement(tag);
  setVisualizerElement(element);
  return element;
}

export function tryToAttachOverlay(overlayDiv: HTMLDivElement) {
  if (document.body) {
    document.body.appendChild(overlayDiv);
  }
}

type EventListenerEntry = {
  type: string;
  cb: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
};

const listenerMap = new WeakMap<EventTarget, EventListenerEntry[]>();

export function addTrackedListener(
  elRef: WeakRef<EventTarget>,
  type: string,
  cb: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): void {
  const el = elRef.deref();
  if (!el) return;

  el.addEventListener(type, cb, options);

  if (!listenerMap.has(el)) {
    listenerMap.set(el, []);
  }

  listenerMap.get(el)?.push({type, cb, options});
}

export function removeAllListeners(elRef: WeakRef<EventTarget>): void {
  const el = elRef.deref();
  if (!el) return;

  const listeners = listenerMap.get(el);
  if (!listeners) return;

  for (const {type, cb, options} of listeners) {
    el.removeEventListener(type, cb, options);
  }

  listenerMap.delete(el);
}

export function debounce<T extends (...args: AnyValue[]) => AnyValue>(
  callback: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      callback(...args);
    }, delay);
  };
}
