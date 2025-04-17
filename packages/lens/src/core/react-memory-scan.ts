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
import type {
  AnalysisResult,
  AnalysisResultCallback,
  BoundingRect,
  CreateOptions,
  DOMElementInfo,
  Optional,
  ScanResult,
  AnyValue,
} from './types';
import type {BasicExtension} from '../extensions/basic-extension';

import * as utils from '../utils/utils';
import ReactFiberAnalyzer from './react-fiber-analysis';
import {
  traverseFiber,
  getFiberNodeFromElement,
  getDisplayNameOfFiberNode,
} from '../utils/react-fiber-utils';
import {DOMObserver} from './dom-observer';
import {isValidComponentName} from './valid-component-name';
import {config} from '../config/config';

export default class ReactMemoryScan {
  static nextElementId = 0;
  #elementWeakRefs: Array<WeakRef<Element>>;
  #isActivated: boolean;
  #intervalId: NodeJS.Timeout;
  #elementToBoundingRects: WeakMap<Element, BoundingRect>;
  #elementToComponent: WeakMap<Element, string>;
  #knownFiberNodes: Array<WeakRef<Fiber>>;
  #fiberAnalyzer: ReactFiberAnalyzer;
  #isDevMode: boolean;
  #subscribers: Array<AnalysisResultCallback>;
  #extensions: Array<BasicExtension>;
  #scanIntervalMs: number;
  #domObserver: Optional<DOMObserver>;

  constructor(options: CreateOptions = {}) {
    this.#elementWeakRefs = [];
    this.#isActivated = false;
    this.#elementToBoundingRects = new WeakMap();
    this.#elementToComponent = new WeakMap();
    this.#knownFiberNodes = [];

    this.#fiberAnalyzer = new ReactFiberAnalyzer();
    this.#intervalId = 0 as unknown as NodeJS.Timeout;
    this.#isDevMode = options.isDevMode ?? false;
    this.#subscribers = options.subscribers ?? [];
    this.#extensions = options.extensions ?? [];
    this.#scanIntervalMs =
      options.scanIntervalMs ?? config.performance.scanIntervalMs;
  }

  #log(...args: AnyValue[]): void {
    if (this.#isDevMode && config.features.enableConsoleLogs) {
      utils.consoleLog(...args);
    }
  }

  subscribe(callback: AnalysisResultCallback): () => void {
    this.#subscribers.push(callback);
    return () => this.unsubscribe(callback);
  }

  unsubscribe(callback: AnalysisResultCallback): void {
    this.#subscribers = this.#subscribers.filter(cb => cb !== callback);
  }

  #notifySubscribers(result: AnalysisResult): void {
    for (const subscriber of this.#subscribers) {
      subscriber(result);
    }
    const duration = result.end - result.start;
    this.#log('duration: ', `${duration} ms`);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {scanner, leakedFibers, fiberNodes, ...rest} = result;
    this.#log(rest);
  }

  registerExtension(extension: BasicExtension): () => void {
    this.#extensions.push(extension);
    return () => this.unregisterExtension(extension);
  }

  unregisterExtension(extension: BasicExtension): void {
    this.#extensions = this.#extensions.filter(e => e !== extension);
  }

  #notifyExtensionsBeforeScan(): void {
    for (const extension of this.#extensions) {
      extension?.beforeScan();
    }
  }

  #notifyExtensionsAfterScan(result: AnalysisResult): void {
    for (const extension of this.#extensions) {
      extension?.afterScan(result);
    }
  }

  start() {
    this.#isActivated = true;
    this.#intervalId = setInterval(
      this.#scanCycle.bind(this),
      this.#scanIntervalMs,
    );
    if (config.features.enableMutationObserver) {
      if (this.#domObserver == null) {
        this.#domObserver = new DOMObserver();
        // NOTE: do not update the fiber or component information here
        // with this.#domObserver.register as those elements in the delta
        // list may be unmounted or just attached and their shape and
        // component info is not correct or not set yet
      }
      this.#domObserver.startMonitoring();
    }
    console.log('[Memory] Tracking React and DOM memory...');
  }

  #scanCycle() {
    if (!this.#isActivated) {
      return;
    }
    this.#notifyExtensionsBeforeScan();
    const start = performance.now();
    const stats = this.scan();
    const end = performance.now();

    // inform subscribers and extensions
    const analysiResult = {
      ...stats,
      start,
      end,
      scanner: this,
    };
    this.#notifySubscribers(analysiResult);
    this.#notifyExtensionsAfterScan(analysiResult);
  }

  pause() {
    this.#isActivated = false;
  }

  stop() {
    this.#isActivated = false;
    clearInterval(this.#intervalId);
    this.#elementWeakRefs = [];
    this.#domObserver?.stopMonitoring();
  }

  recordBoundingRectangles(elementRefs: Array<WeakRef<Element>>) {
    for (const elemRef of elementRefs) {
      const element = elemRef.deref();
      if (element == null || this.#elementToBoundingRects.has(element)) {
        continue;
      }
      const rect = utils.getBoundingClientRect(element);
      if (rect != null) {
        this.#elementToBoundingRects.set(element, rect);
      }
    }
  }

  getDetachedDOMInfo(): Array<DOMElementInfo> {
    const detachedDOMElements = [];
    for (const weakRef of this.#elementWeakRefs) {
      const element = weakRef.deref();
      if (element == null || element.isConnected) {
        continue;
      }
      // add a unique id to that detach dom element
      const elem = element as AnyValue;
      if (elem.detachedElementId == null) {
        const elementId = ReactMemoryScan.nextElementId++;
        elem.detachedElementIdStr = `memory-id-${elementId}@`;
        elem.detachedElementId = elementId;
      }
      const component = this.#elementToComponent.get(element);
      detachedDOMElements.push({
        element: weakRef,
        boundingRect: this.#elementToBoundingRects.get(element),
        component,
      });
    }
    return detachedDOMElements;
  }

  isDevMode(): boolean {
    return this.#isDevMode;
  }

  #updateElementToComponentInfo(elements: Array<WeakRef<Element>>): void {
    for (const elemRef of elements) {
      const element = elemRef.deref();
      if (element == null || this.#elementToComponent.has(element)) {
        continue;
      }
      const fiberNode = getFiberNodeFromElement(element);
      if (fiberNode == null) {
        continue;
      }
      traverseFiber(
        fiberNode,
        (parent: Fiber) => {
          const displayName = getDisplayNameOfFiberNode(parent);
          if (displayName != null && isValidComponentName(displayName)) {
            this.#elementToComponent.set(element, displayName);
            return true;
          }
        },
        true,
      );
    }
  }

  updateFiberNodes(fiberNodes: Array<WeakRef<Fiber>>): Array<WeakRef<Fiber>> {
    const knownFiberSet = new WeakSet<Fiber>();
    for (const fiberNode of this.#knownFiberNodes) {
      const fiber = fiberNode.deref();
      if (fiber != null) {
        knownFiberSet.add(fiber);
      }
    }
    const newFiberSet = new WeakSet<Fiber>();
    for (const fiberNode of fiberNodes) {
      const fiber = fiberNode.deref();
      if (fiber != null) {
        newFiberSet.add(fiber);
      }
    }
    const leakedFibers: Array<WeakRef<Fiber>> = [];
    const newExistingFibers: Array<WeakRef<Fiber>> = [];
    // clean up and compact the existing fiber node lists
    for (const fiberRef of this.#knownFiberNodes) {
      const fiber = fiberRef.deref();
      if (fiber == null) {
        continue;
      }
      if (!newFiberSet.has(fiber)) {
        leakedFibers.push(fiberRef);
      } else {
        newExistingFibers.push(fiberRef);
        if (fiber.return == null) {
          leakedFibers.push(fiberRef);
        }
      }
    }
    // add new fibers to the existing list
    for (const fiberRef of fiberNodes) {
      const fiber = fiberRef.deref();
      if (fiber == null) {
        continue;
      }
      if (!knownFiberSet.has(fiber)) {
        newExistingFibers.push(fiberRef);
      }
    }
    this.#knownFiberNodes = newExistingFibers;
    this.#log('known fibers: ', this.#knownFiberNodes.length);
    this.#log('leaked fibers: ', leakedFibers.length);
    return leakedFibers;
  }

  packLeakedFibers(leakedFibers: Array<WeakRef<Fiber>>): Array<LeakedFiber> {
    const ret = [];
    for (const leakedFiber of leakedFibers) {
      ret.push(new LeakedFiber(leakedFiber));
    }
    return ret;
  }

  #getTrackedDOMRefs(): Array<WeakRef<Element>> {
    if (this.#domObserver == null) {
      return utils.getDOMElements();
    }
    return [...utils.getDOMElements(), ...this.#domObserver.getDOMElements()];
  }

  #runGC(): void {
    if ((window as AnyValue)?.gc != null) {
      (window as AnyValue).gc();
    }
  }

  scan(): ScanResult {
    const start = Date.now();
    this.#runGC();
    const weakRefList = this.#elementWeakRefs;
    // TODO: associate elements with URL and other metadata
    const allElements = this.#getTrackedDOMRefs();
    this.#updateElementToComponentInfo(allElements);
    this.recordBoundingRectangles(allElements);
    utils.updateWeakRefList(weakRefList, allElements);
    const scanResult = this.#fiberAnalyzer.scan(
      weakRefList,
      this.#elementToComponent,
    );
    const leakedFibers = this.updateFiberNodes(scanResult.fiberNodes);
    scanResult.leakedFibers = leakedFibers;
    (window as AnyValue).leakedFibers = this.packLeakedFibers(leakedFibers);
    const end = Date.now();
    this.#log(`scan took ${end - start}ms`);
    return scanResult;
  }
}

class LeakedFiber {
  leakedFiber: WeakRef<Fiber>;

  constructor(fiber: WeakRef<Fiber>) {
    this.leakedFiber = fiber;
  }
}
