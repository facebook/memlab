/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import * as utils from '../utils/utils';
import type {Fiber} from 'react-reconciler';
import {
  traverseFiber,
  getDisplayNameOfFiberNode,
  getFiberNodeFromElement,
  getTopMostFiberWithChild,
} from '../utils/react-fiber-utils';
import {ScanResult, AnyValue} from './types';

export default class ReactFiberAnalyzer {
  scan(
    elementWeakRefList: Array<WeakRef<Element>>,
    elementToComponent: WeakMap<Element, string>,
  ): ScanResult {
    const visitedRootFibers = new Set<Fiber>();
    const components = new Set<string>();
    const componentToFiberNodeCount = new Map();
    const detachedComponentToFiberNodeCount = new Map();
    const topDownVisited = new Set();
    const analyzedFibers = new Set();
    const fiberNodes: Array<WeakRef<Fiber>> = [];
    let totalElements = 0;
    let totalDetachedElements = 0;

    function analyzeFiber(fiberNode: Fiber): void {
      traverseFiber(
        fiberNode,
        (fiberNode: Fiber) => {
          // skip if the fiber node has already been analyzed
          if (analyzedFibers.has(fiberNode)) {
            return true;
          }
          analyzedFibers.add(fiberNode);

          // traverse the fiber tree up to find the component name
          const displayName = getDisplayNameOfFiberNode(fiberNode);
          if (displayName != null) {
            components.add(displayName);
            utils.addCountbyKey(componentToFiberNodeCount, displayName, 1);
            return true;
          }
        },
        true,
      );
    }

    for (const weakRef of elementWeakRefList) {
      const elem = weakRef.deref();
      if (elem == null) {
        continue;
      }
      // elements stats
      ++totalElements;
      // TODO: simplify this logic
      if (!elem.isConnected) {
        if (elementToComponent.has(elem)) {
          const component = elementToComponent.get(elem);
          // set component name
          (elem as AnyValue).__component_name = component;
          utils.addCountbyKey(detachedComponentToFiberNodeCount, component, 1);
        }
        ++totalDetachedElements;
      }

      // analyze fiber nodes
      const fiberNode = getFiberNodeFromElement(elem);
      if (fiberNode == null) {
        continue;
      }
      analyzeFiber(fiberNode);

      // try to traverse each fiber node in the entire fiber tree
      const rootFiber = getTopMostFiberWithChild(fiberNode);
      if (rootFiber == null) {
        continue;
      }
      if (visitedRootFibers.has(rootFiber)) {
        continue;
      }
      visitedRootFibers.add(rootFiber);

      // start traversing fiber tree from the know root host
      traverseFiber(
        rootFiber,
        (node: Fiber) => {
          if (topDownVisited.has(node)) {
            return true;
          }
          topDownVisited.add(node);
          fiberNodes.push(new WeakRef(node));
          analyzeFiber(node);
        },
        false,
      );
    }

    topDownVisited.clear();
    analyzedFibers.clear();
    visitedRootFibers.clear();

    return {
      components,
      componentToFiberNodeCount,
      totalElements,
      totalDetachedElements,
      detachedComponentToFiberNodeCount,
      fiberNodes,
      leakedFibers: [],
    };
  }
}
