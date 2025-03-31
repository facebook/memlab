/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type {Fiber} from 'react-reconciler';
import type {Nullable, Optional, AnyValue} from '../core/types';
import {getMeaningfulName} from './utils';

export const ClassComponentTag = 1;
export const FunctionComponentTag = 0;
export const ContextConsumerTag = 9;
export const SuspenseComponentTag = 13;
export const OffscreenComponentTag = 22;
export const ForwardRefTag = 11;
export const MemoComponentTag = 14;
export const SimpleMemoComponentTag = 15;
export const HostComponentTag = 5;
export const HostHoistableTag = 26;
export const HostSingletonTag = 27;
export const DehydratedSuspenseComponent = 18;
export const HostText = 6;
export const Fragment = 7;
export const LegacyHiddenComponent = 23;
export const OffscreenComponent = 22;
export const HostRoot = 3;
export const CONCURRENT_MODE_NUMBER = 0xeacf;
export const CONCURRENT_MODE_SYMBOL_STRING = 'Symbol(react.concurrent_mode)';
export const DEPRECATED_ASYNC_MODE_SYMBOL_STRING = 'Symbol(react.async_mode)';

// https://github.com/facebook/react/blob/main/packages/react-reconciler/src/ReactFiberFlags.js
export const PerformedWork = 0b1;
export const Placement = 0b10;
export const DidCapture = 0b10000000;
export const Hydrating = 0b1000000000000;
export const Update = 0b100;
export const Cloned = 0b1000;
export const ChildDeletion = 0b10000;
export const ContentReset = 0b100000;
export const Ref = 0b1000000000;
export const Snapshot = 0b10000000000;
export const Visibility = 0b10000000000000;
export const MutationMask =
  Placement |
  Update |
  ChildDeletion |
  ContentReset |
  Hydrating |
  Visibility |
  Snapshot;

/**
 * @see https://reactnative.dev/architecture/glossary#host-view-tree-and-host-view
 */
export const isHostFiber = (fiber: Fiber) =>
  fiber.tag === HostComponentTag ||
  // @ts-expect-error: it exists
  fiber.tag === HostHoistableTag ||
  // @ts-expect-error: it exists
  fiber.tag === HostSingletonTag ||
  typeof fiber.type === 'string';

export const getNearestHostFiber = (fiber: Fiber) => {
  let hostFiber = traverseFiber(fiber, isHostFiber);
  if (!hostFiber) {
    hostFiber = traverseFiber(fiber, isHostFiber, true);
  }
  return hostFiber;
};

export const getTopMostHostFiber = (fiber: Fiber): Nullable<Fiber> => {
  let topMostHostFiber: Nullable<Fiber> = null;
  function checkFiber(fiber: Fiber): void {
    if (isHostFiber(fiber)) {
      topMostHostFiber = fiber;
    }
  }
  traverseFiber(fiber, checkFiber, true);
  return topMostHostFiber;
};

export const getTopMostFiberWithChild = (fiber: Fiber): Nullable<Fiber> => {
  let topMostFiber: Nullable<Fiber> = null;
  function checkFiber(fiber: Fiber): void {
    if (fiber.child != null) {
      topMostFiber = fiber;
    }
  }
  traverseFiber(fiber, checkFiber, true);
  return topMostFiber;
};

export const traverseFiber = (
  fiber: Nullable<Fiber>,
  selector: (node: Fiber) => boolean | void,
  ascending = false,
): Nullable<Fiber> => {
  if (!fiber) {
    return null;
  }
  if (selector(fiber) === true) {
    return fiber;
  }

  let child = ascending ? fiber.return : fiber.child;
  while (child) {
    const match = traverseFiber(child, selector, ascending);
    if (match) {
      return match;
    }
    child = ascending ? null : child.sibling;
  }
  return null;
};

// React internal property keys
const internalKeys = [
  '__reactFiber$', // React 17+
  '__reactInternalInstance$', // React 16
  '_reactRootContainer', // React Root
];

const getOwnPropertyNames = Object.getOwnPropertyNames.bind(Object);

export function getFiberNodeFromElement(element: Element) {
  for (const prefix of internalKeys) {
    // Use Object.keys only as fallback since it's slower
    const key = getOwnPropertyNames(element).find(k => k.startsWith(prefix));

    if (key) {
      return (element as AnyValue)[key];
    }
  }
  return null;
}

export function getDisplayNameOfFiberNode(node: Fiber) {
  const elementType = node.type ?? node.elementType;

  // Try to get name from displayName or name properties
  let displayName: Optional<string> =
    elementType?.displayName ?? elementType?.name;

  // Handle class components and forwardRef
  if (displayName == null) {
    if (elementType?.render) {
      // Class components
      const render = elementType?.render;
      displayName = render?.displayName ?? render?.name;
    } else if (elementType?.type) {
      // ForwardRef components
      displayName = elementType.type.displayName ?? elementType.type.name;
    }
  }

  // Handle anonymous functions
  if (!displayName && typeof elementType === 'function') {
    displayName = elementType.name;
  }
  return getMeaningfulName(extractReactComponentName(displayName));
}

export function isFunctionalComponent(node: Fiber) {
  const elementType = node?.elementType;
  return typeof elementType === 'function';
}

// dom-element [from component.react] --> component.react
export function extractReactComponentName(
  displayName: Optional<string>,
): Nullable<string> {
  if (typeof displayName !== 'string') {
    return null;
  }
  if (!displayName.includes('[') || !displayName.includes(']')) {
    return displayName;
  }
  const startIndex = displayName.indexOf('[');
  const endIndex = displayName.indexOf(']');
  if (startIndex > endIndex) {
    return displayName;
  }
  const name = displayName.substring(startIndex + 1, endIndex);
  if (name.startsWith('from ')) {
    return name.substring('from '.length);
  }
  return name;
}
