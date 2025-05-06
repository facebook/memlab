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
import {getFiberNodeFromElement} from '../utils/react-fiber-utils';
import {WeakMapPlus} from '../utils/weak-ref-utils';

type EventListenerEntry = {
  type: string;
  cb: WeakRef<EventListenerOrEventListenerObject>;
  options?: boolean | AddEventListenerOptions;
  fiber?: WeakRef<Fiber>;
};

type DetachedListenerGroup = {
  type: string;
  count: number;
  entries: WeakRef<EventListenerEntry>[];
};

export class EventListenerTracker {
  private static instance: EventListenerTracker | null = null;
  #listenerMap: WeakMapPlus<EventTarget, EventListenerEntry[]>;
  #detachedListeners: Map<string, DetachedListenerGroup[]>;
  #originalAddEventListener: typeof EventTarget.prototype.addEventListener;
  #originalRemoveEventListener: typeof EventTarget.prototype.removeEventListener;

  private constructor() {
    this.#listenerMap = new WeakMapPlus({fallback: 'noop', cleanupMs: 100});
    this.#detachedListeners = new Map();
    this.#originalAddEventListener = EventTarget.prototype.addEventListener;
    this.#originalRemoveEventListener =
      EventTarget.prototype.removeEventListener;
    this.#patchEventListeners();
  }

  static getInstance(): EventListenerTracker {
    if (!EventListenerTracker.instance) {
      EventListenerTracker.instance = new EventListenerTracker();
    }
    return EventListenerTracker.instance;
  }

  #patchEventListeners(): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    EventTarget.prototype.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      self.#originalAddEventListener.call(this, type, listener, options);
      if (this instanceof Element) {
        const fiber = getFiberNodeFromElement(this);
        const entry: EventListenerEntry = {
          type,
          cb: new WeakRef(listener),
          options,
          fiber: fiber ? new WeakRef(fiber) : undefined,
        };
        const listeners = self.#listenerMap.get(this) ?? [];
        listeners.push(entry);
        self.#listenerMap.set(this, listeners);
      }
    };

    EventTarget.prototype.removeEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) {
      self.#originalRemoveEventListener.call(this, type, listener, options);
      if (this instanceof Element) {
        const listeners = self.#listenerMap.get(this);
        if (listeners) {
          const index = listeners.findIndex(
            entry =>
              entry.type === type &&
              entry.cb.deref() === listener &&
              entry.options === options,
          );
          if (index !== -1) {
            listeners.splice(index, 1);
          }
          if (listeners.length === 0) {
            self.#listenerMap.delete(this);
          } else {
            self.#listenerMap.set(this, listeners);
          }
        }
      }
    };
  }

  #unpatchEventListeners(): void {
    EventTarget.prototype.addEventListener = this.#originalAddEventListener;
    EventTarget.prototype.removeEventListener =
      this.#originalRemoveEventListener;
  }

  addListener(
    el: EventTarget,
    type: string,
    cb: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    el.addEventListener(type, cb, options);
  }

  removeListener(
    el: EventTarget,
    type: string,
    cb: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    el.removeEventListener(type, cb, options);
  }

  scan(
    getComponentName: (elRef: WeakRef<Element>) => string,
  ): Map<string, DetachedListenerGroup[]> {
    const detachedListeners = new Map<string, DetachedListenerGroup[]>();

    for (const [el, listeners] of this.#listenerMap.entries()) {
      if (el instanceof Element && !el.isConnected) {
        for (const listener of listeners) {
          // Skip if the callback has been garbage collected
          if (!listener.cb.deref()) continue;

          const componentName = getComponentName(new WeakRef(el));
          if (!detachedListeners.has(componentName)) {
            detachedListeners.set(componentName, []);
          }

          const groups = detachedListeners.get(componentName);
          let group = groups?.find(g => g.type === listener.type);
          if (!group) {
            group = {
              type: listener.type,
              count: 0,
              entries: [],
            };
            groups?.push(group);
          }
          group.count++;
          group.entries.push(new WeakRef(listener));
        }
      }
    }

    this.#detachedListeners = detachedListeners;
    return detachedListeners;
  }

  getDetachedListeners(): Map<string, DetachedListenerGroup[]> {
    return this.#detachedListeners;
  }

  destroy(): void {
    this.#unpatchEventListeners();
    this.#listenerMap.destroy();
    this.#detachedListeners.clear();
    EventListenerTracker.instance = null;
  }
}
