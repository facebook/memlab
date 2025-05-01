/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type {
  BoundingRect,
  Nullable,
  AnyValue,
  ObjectValue,
} from '../core/types';
import {isVisualizerElement} from '../visual/visual-utils';

export function getDOMElements(): Array<WeakRef<Element>> {
  const elements = Array.from(document.querySelectorAll('*'));
  const ret = [];
  for (const element of elements) {
    if (isVisualizerElement(element)) {
      continue;
    }
    ret.push(new WeakRef(element));
  }
  return ret;
}

export function getDOMElementCount(): number {
  const elements = Array.from(document.querySelectorAll('*'));
  let ret = 0;
  for (const element of elements) {
    if (isVisualizerElement(element)) {
      continue;
    }
    ++ret;
  }
  return ret;
}

export function getMeaningfulName(name: Nullable<string>) {
  if (name == null) {
    return null;
  }
  const isMinified = isMinifiedName(name);
  return isMinified ? null : name;
}

/**
 * Determines if a given function or class name is minified.
 *
 * @param {string} name - The function or class name to check.
 * @return {boolean} - Returns true if the name is likely minified, otherwise false.
 */
export function isMinifiedName(name: string): boolean {
  if (name.length >= 5) {
    return false;
  }
  // Minified names are often very short, e.g., "a", "b", "c"
  if (name.length <= 3) {
    return true;
  }

  // Names with non-alphanumeric characters (except $ and _) are unlikely to be minified
  if (/[^a-zA-Z0-9$_]/.test(name)) {
    return false;
  }

  // Minified names rarely have meaningful words (detect camelCase or PascalCase)
  const hasMeaningfulPattern =
    /^[A-Z][a-z]+([A-Z][a-z]*)*$|^[a-z]+([A-Z][a-z]*)*$/.test(name);
  return !hasMeaningfulPattern;
}

export function addCountbyKey<K extends ObjectValue>(
  map: WeakMap<K, number>,
  key: K,
  count: number,
) {
  map.set(key, (map.get(key) ?? 0) + count);
}

export function updateWeakRefList(
  weakRefList: Array<WeakRef<Element>>,
  elementRefs: Array<WeakRef<Element>>,
) {
  consolidateWeakRefList(weakRefList);
  const set = getElementsSet(weakRefList);
  for (const elementRef of elementRefs) {
    const element = elementRef.deref();
    if (element == null || set.has(element)) {
      continue;
    }
    set.add(element);
    weakRefList.push(new WeakRef(element));
  }
  return weakRefList;
}

function getElementsSet(weakRefList: Array<WeakRef<Element>>) {
  const set = new Set();
  for (const weakRef of weakRefList) {
    set.add(weakRef.deref());
  }
  return set;
}

function consolidateWeakRefList(weakRefList: Array<WeakRef<Element>>) {
  const alternative = [];
  for (const weakRef of weakRefList) {
    const element = weakRef.deref();
    if (element == null) {
      continue;
    }
    alternative.push(weakRef);
  }
  while (weakRefList.length > 0) {
    weakRefList.pop();
  }
  for (const weakRef of alternative) {
    weakRefList.push(weakRef);
  }
  return weakRefList;
}

export function getBoundingClientRect(
  element: Element,
): Nullable<BoundingRect> {
  if (element == null) {
    return null;
  }
  if (typeof element.getBoundingClientRect !== 'function') {
    return null;
  }
  let rect = null;
  try {
    rect = element.getBoundingClientRect();
  } catch {
    // do nothing
  }
  if (rect == null) {
    return null;
  }
  const scrollTop = window.scrollY;
  const scrollLeft = window.scrollX;
  const ret: BoundingRect = {} as unknown as BoundingRect;
  ret.bottom = rect.bottom;
  ret.height = rect.height;
  ret.left = rect.left;
  ret.right = rect.right;
  ret.top = rect.top;
  ret.width = rect.width;
  ret.x = rect.x;
  ret.y = rect.y;
  ret.scrollLeft = scrollLeft;
  ret.scrollTop = scrollTop;
  return ret as BoundingRect;
}

const _console = console;
const _consoleLog = _console.log;

export function consoleLog(...args: AnyValue[]) {
  _consoleLog.apply(_console, args);
}

const SESSION_STORAGE_KEY = 'memory_lens_session';

function isSessionStorageAvailable(): boolean {
  try {
    const testKey = '__memory_lens_session_test__';
    sessionStorage.setItem(testKey, '1');
    sessionStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

export function hasRunInSession(): boolean {
  if (!isSessionStorageAvailable()) {
    return false;
  }
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setRunInSession(): void {
  if (!isSessionStorageAvailable()) {
    return;
  }
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, 'true');
  } catch {
    // do nothing
  }
}
