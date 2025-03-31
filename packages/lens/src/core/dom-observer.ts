/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import {isWeakAPINative} from '../utils/weak-ref-utils';
import {isVisualizerElement} from '../visual/visual-utils';
import {DOMElementStats, DOMObserveCallback, Optional} from './types';

// if false, we only capture the top-most element of a removed subtree
const CAPTURE_ALL_REMOVED_ELEMENTS = true;
const IS_WEAK_REF_NATIVE = isWeakAPINative();
const IS_MUTATION_OBSERVER_SUPPORTED = window.MutationObserver !== undefined;

export class DOMObserver {
  #elementCount: number;
  #detachedElementCount: number;
  #mutationObserver: Optional<MutationObserver>;
  #trackedElements: Array<WeakRef<Element>>;
  #trackedElementSet: WeakSet<Element>;
  #consolidateInterval: Optional<number>;
  #observeCallback: Array<DOMObserveCallback>;

  constructor() {
    this.#elementCount = 0;
    this.#detachedElementCount = 0;
    this.#trackedElements = [];
    this.#trackedElementSet = new WeakSet();
    this.#observeCallback = [];
    this.startMonitoring();
  }

  register(callback: DOMObserveCallback): void {
    this.#observeCallback.push(callback);
  }

  startMonitoring(): void {
    if (!IS_WEAK_REF_NATIVE || !IS_MUTATION_OBSERVER_SUPPORTED) {
      return;
    }
    if (this.#mutationObserver != null) {
      return;
    }
    this.#mutationObserver = new MutationObserver(mutationsList => {
      let newlyAdded: Array<WeakRef<Element>> = [];
      const updateCallback = (node: Node) => {
        if (node == null) {
          return;
        }
        if (node.nodeType != Node.ELEMENT_NODE) {
          return;
        }
        const element = node as Element;
        if (isVisualizerElement(element)) {
          return;
        }
        if (CAPTURE_ALL_REMOVED_ELEMENTS) {
          const diff = this.#gatherAllElementsInRemovedSubtree(element);
          newlyAdded = [...newlyAdded, ...diff];
        } else if (!this.#trackedElementSet.has(element)) {
          const ref = new WeakRef(element);
          this.#trackedElements.push(ref);
          this.#trackedElementSet.add(element);
          newlyAdded.push(ref);
        }
      };

      mutationsList.forEach(mutation => {
        mutation.addedNodes.forEach(updateCallback);
        mutation.removedNodes.forEach(updateCallback);
      });

      this.#observeCallback.forEach(cb => cb(newlyAdded));
    });

    const waitForBodyAndObserve = () => {
      if (document.body) {
        // observe changes in DOM tree
        this.#mutationObserver?.observe(document.body, {
          childList: true, // Detect direct additions/removals
          subtree: true, // Observe all descendants
        });
      } else {
        setTimeout(waitForBodyAndObserve, 0);
      }
    };

    waitForBodyAndObserve();

    // starts consolidating removedElements weak references;
    this.#consolidateInterval = window.setInterval(() => {
      this.#consolidateElementRefs();
    }, 3000);
  }

  stopMonitoring(): void {
    if (this.#mutationObserver != null) {
      this.#mutationObserver.disconnect();
      this.#mutationObserver = null;
    }
    if (this.#consolidateInterval != null) {
      window.clearInterval(this.#consolidateInterval);
      this.#consolidateInterval = null;
    }
    // TODO: clean up memory
  }

  #consolidateElementRefs(): void {
    const consolidatedList = [];
    const trackedElements = new Set<Element>();
    for (const ref of this.#trackedElements) {
      const element = ref.deref();
      if (element != null && !trackedElements.has(element)) {
        consolidatedList.push(ref);
        trackedElements.add(element);
      }
    }
    this.#trackedElements = consolidatedList;
  }

  #getTotalDOMElementCount(): number {
    return (this.#elementCount =
      document?.getElementsByTagName('*')?.length ?? 0);
  }

  #getDetachedElementCount(): number {
    let count = 0;
    for (const ref of this.#trackedElements) {
      const element = ref.deref();
      if (element && element.isConnected === false) {
        ++count;
      }
    }
    return (this.#detachedElementCount = count);
  }

  #gatherAllElementsInRemovedSubtree(node: Node): Array<WeakRef<Element>> {
    const queue = [node];
    const visited = new Set<Node>();
    const newlyAdded: Array<WeakRef<Element>> = [];
    while (queue.length > 0) {
      const current = queue.pop();
      if (current == null || visited.has(current)) {
        continue;
      }
      if (current?.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }
      const element = current as Element;
      if (isVisualizerElement(element)) {
        continue;
      }
      visited.add(element);
      if (!this.#trackedElementSet.has(element)) {
        const ref = new WeakRef(element);
        this.#trackedElements.push(ref);
        this.#trackedElementSet.add(element);
        newlyAdded.push(ref);
      }
      const list = element.childNodes;
      for (let i = 0; i < list.length; ++i) {
        queue.push(list[i]);
      }
    }
    return newlyAdded;
  }

  getDOMElements(): Array<WeakRef<Element>> {
    return [...this.#trackedElements];
  }

  getStats(): DOMElementStats {
    try {
      this.#elementCount = this.#getTotalDOMElementCount();
      this.#detachedElementCount = this.#getDetachedElementCount();
    } catch (ex) {
      // do nothing
    }

    return {
      elements: this.#elementCount,
      detachedElements: this.#detachedElementCount,
    };
  }
}
