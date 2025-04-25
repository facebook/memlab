/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
export class IntersectionObserverManager {
  private static instance: IntersectionObserverManager;
  private observer: IntersectionObserver;
  private observedElements: Map<
    HTMLElement,
    (entry: IntersectionObserverEntry) => void
  > = new Map();

  private constructor() {
    this.observer = new IntersectionObserver(
      entries => {
        entries.forEach((entry: IntersectionObserverEntry) => {
          const element = entry.target as HTMLElement;
          const callback = this.observedElements.get(element);
          if (callback) {
            callback(entry);
          }
        });
      },
      {
        // Only trigger when element is completely out of viewport
        threshold: 0,
        // Add some margin to trigger before element is completely out of view
        rootMargin: '50px',
      },
    );
  }

  public static getInstance(): IntersectionObserverManager {
    if (!IntersectionObserverManager.instance) {
      IntersectionObserverManager.instance = new IntersectionObserverManager();
    }
    return IntersectionObserverManager.instance;
  }

  public observe(
    elementRef: WeakRef<HTMLElement>,
    callback: (entry: IntersectionObserverEntry) => void,
  ) {
    const element = elementRef.deref();
    if (element == null) {
      return;
    }
    this.observedElements.set(element, callback);
    this.observer.observe(element);
  }

  public unobserve(elementRef: WeakRef<HTMLElement>) {
    const element = elementRef.deref();
    if (element == null) {
      return;
    }
    this.observedElements.delete(element);
    this.observer.unobserve(element);
  }
}
