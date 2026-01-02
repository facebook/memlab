/* @generated */
/* @nolint */
/**
 * @license MemLab
 * MIT License
 * 
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * 
 */
(function webpackUniversalModuleDefinition(root, factory) {
	if(typeof exports === 'object' && typeof module === 'object')
		module.exports = factory();
	else if(typeof define === 'function' && define.amd)
		define([], factory);
	else if(typeof exports === 'object')
		exports["MemLens"] = factory();
	else
		root["MemLens"] = factory();
})(self, () => {
return /******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ 54
(__unused_webpack_module, exports, __webpack_require__) {


var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _DOMObserver_instances, _DOMObserver_elementCount, _DOMObserver_detachedElementCount, _DOMObserver_mutationObserver, _DOMObserver_trackedElements, _DOMObserver_trackedElementSet, _DOMObserver_consolidateInterval, _DOMObserver_observeCallback, _DOMObserver_consolidateElementRefs, _DOMObserver_getTotalDOMElementCount, _DOMObserver_getDetachedElementCount, _DOMObserver_gatherAllElementsInRemovedSubtree;
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.DOMObserver = void 0;
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
const weak_ref_utils_1 = __webpack_require__(313);
const visual_utils_1 = __webpack_require__(498);
// if false, we only capture the top-most element of a removed subtree
const CAPTURE_ALL_REMOVED_ELEMENTS = true;
const IS_WEAK_REF_NATIVE = (0, weak_ref_utils_1.isWeakAPINative)();
const IS_MUTATION_OBSERVER_SUPPORTED = window.MutationObserver !== undefined;
class DOMObserver {
    constructor() {
        _DOMObserver_instances.add(this);
        _DOMObserver_elementCount.set(this, void 0);
        _DOMObserver_detachedElementCount.set(this, void 0);
        _DOMObserver_mutationObserver.set(this, void 0);
        _DOMObserver_trackedElements.set(this, void 0);
        _DOMObserver_trackedElementSet.set(this, void 0);
        _DOMObserver_consolidateInterval.set(this, void 0);
        _DOMObserver_observeCallback.set(this, void 0);
        __classPrivateFieldSet(this, _DOMObserver_elementCount, 0, "f");
        __classPrivateFieldSet(this, _DOMObserver_detachedElementCount, 0, "f");
        __classPrivateFieldSet(this, _DOMObserver_trackedElements, [], "f");
        __classPrivateFieldSet(this, _DOMObserver_trackedElementSet, new WeakSet(), "f");
        __classPrivateFieldSet(this, _DOMObserver_observeCallback, [], "f");
        this.startMonitoring();
    }
    register(callback) {
        __classPrivateFieldGet(this, _DOMObserver_observeCallback, "f").push(callback);
    }
    startMonitoring() {
        if (!IS_WEAK_REF_NATIVE || !IS_MUTATION_OBSERVER_SUPPORTED) {
            return;
        }
        if (__classPrivateFieldGet(this, _DOMObserver_mutationObserver, "f") != null) {
            return;
        }
        __classPrivateFieldSet(this, _DOMObserver_mutationObserver, new MutationObserver(mutationsList => {
            let newlyAdded = [];
            const updateCallback = (node) => {
                if (node == null) {
                    return;
                }
                if (node.nodeType != Node.ELEMENT_NODE) {
                    return;
                }
                const element = node;
                if ((0, visual_utils_1.isVisualizerElement)(element)) {
                    return;
                }
                if (CAPTURE_ALL_REMOVED_ELEMENTS) {
                    const diff = __classPrivateFieldGet(this, _DOMObserver_instances, "m", _DOMObserver_gatherAllElementsInRemovedSubtree).call(this, element);
                    newlyAdded = [...newlyAdded, ...diff];
                }
                else if (!__classPrivateFieldGet(this, _DOMObserver_trackedElementSet, "f").has(element)) {
                    const ref = new WeakRef(element);
                    __classPrivateFieldGet(this, _DOMObserver_trackedElements, "f").push(ref);
                    __classPrivateFieldGet(this, _DOMObserver_trackedElementSet, "f").add(element);
                    newlyAdded.push(ref);
                }
            };
            mutationsList.forEach(mutation => {
                mutation.addedNodes.forEach(updateCallback);
                mutation.removedNodes.forEach(updateCallback);
            });
            __classPrivateFieldGet(this, _DOMObserver_observeCallback, "f").forEach(cb => cb(newlyAdded));
        }), "f");
        const waitForBodyAndObserve = () => {
            var _a;
            if (document.body) {
                // observe changes in DOM tree
                (_a = __classPrivateFieldGet(this, _DOMObserver_mutationObserver, "f")) === null || _a === void 0 ? void 0 : _a.observe(document.body, {
                    childList: true, // Detect direct additions/removals
                    subtree: true, // Observe all descendants
                });
            }
            else {
                setTimeout(waitForBodyAndObserve, 0);
            }
        };
        waitForBodyAndObserve();
        // starts consolidating removedElements weak references;
        __classPrivateFieldSet(this, _DOMObserver_consolidateInterval, window.setInterval(() => {
            __classPrivateFieldGet(this, _DOMObserver_instances, "m", _DOMObserver_consolidateElementRefs).call(this);
        }, 3000), "f");
    }
    stopMonitoring() {
        if (__classPrivateFieldGet(this, _DOMObserver_mutationObserver, "f") != null) {
            __classPrivateFieldGet(this, _DOMObserver_mutationObserver, "f").disconnect();
            __classPrivateFieldSet(this, _DOMObserver_mutationObserver, null, "f");
        }
        if (__classPrivateFieldGet(this, _DOMObserver_consolidateInterval, "f") != null) {
            window.clearInterval(__classPrivateFieldGet(this, _DOMObserver_consolidateInterval, "f"));
            __classPrivateFieldSet(this, _DOMObserver_consolidateInterval, null, "f");
        }
        // TODO: clean up memory
    }
    getDOMElements() {
        return [...__classPrivateFieldGet(this, _DOMObserver_trackedElements, "f")];
    }
    getStats() {
        try {
            __classPrivateFieldSet(this, _DOMObserver_elementCount, __classPrivateFieldGet(this, _DOMObserver_instances, "m", _DOMObserver_getTotalDOMElementCount).call(this), "f");
            __classPrivateFieldSet(this, _DOMObserver_detachedElementCount, __classPrivateFieldGet(this, _DOMObserver_instances, "m", _DOMObserver_getDetachedElementCount).call(this), "f");
        }
        catch (ex) {
            // do nothing
        }
        return {
            elements: __classPrivateFieldGet(this, _DOMObserver_elementCount, "f"),
            detachedElements: __classPrivateFieldGet(this, _DOMObserver_detachedElementCount, "f"),
        };
    }
}
exports.DOMObserver = DOMObserver;
_DOMObserver_elementCount = new WeakMap(), _DOMObserver_detachedElementCount = new WeakMap(), _DOMObserver_mutationObserver = new WeakMap(), _DOMObserver_trackedElements = new WeakMap(), _DOMObserver_trackedElementSet = new WeakMap(), _DOMObserver_consolidateInterval = new WeakMap(), _DOMObserver_observeCallback = new WeakMap(), _DOMObserver_instances = new WeakSet(), _DOMObserver_consolidateElementRefs = function _DOMObserver_consolidateElementRefs() {
    const consolidatedList = [];
    const trackedElements = new Set();
    for (const ref of __classPrivateFieldGet(this, _DOMObserver_trackedElements, "f")) {
        const element = ref.deref();
        if (element != null && !trackedElements.has(element)) {
            consolidatedList.push(ref);
            trackedElements.add(element);
        }
    }
    __classPrivateFieldSet(this, _DOMObserver_trackedElements, consolidatedList, "f");
}, _DOMObserver_getTotalDOMElementCount = function _DOMObserver_getTotalDOMElementCount() {
    var _a, _b;
    return (__classPrivateFieldSet(this, _DOMObserver_elementCount, (_b = (_a = document === null || document === void 0 ? void 0 : document.getElementsByTagName('*')) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0, "f"));
}, _DOMObserver_getDetachedElementCount = function _DOMObserver_getDetachedElementCount() {
    let count = 0;
    for (const ref of __classPrivateFieldGet(this, _DOMObserver_trackedElements, "f")) {
        const element = ref.deref();
        if (element && element.isConnected === false) {
            ++count;
        }
    }
    return (__classPrivateFieldSet(this, _DOMObserver_detachedElementCount, count, "f"));
}, _DOMObserver_gatherAllElementsInRemovedSubtree = function _DOMObserver_gatherAllElementsInRemovedSubtree(node) {
    const queue = [node];
    const visited = new Set();
    const newlyAdded = [];
    while (queue.length > 0) {
        const current = queue.pop();
        if (current == null || visited.has(current)) {
            continue;
        }
        if ((current === null || current === void 0 ? void 0 : current.nodeType) !== Node.ELEMENT_NODE) {
            continue;
        }
        const element = current;
        if ((0, visual_utils_1.isVisualizerElement)(element)) {
            continue;
        }
        visited.add(element);
        if (!__classPrivateFieldGet(this, _DOMObserver_trackedElementSet, "f").has(element)) {
            const ref = new WeakRef(element);
            __classPrivateFieldGet(this, _DOMObserver_trackedElements, "f").push(ref);
            __classPrivateFieldGet(this, _DOMObserver_trackedElementSet, "f").add(element);
            newlyAdded.push(ref);
        }
        const list = element.childNodes;
        for (let i = 0; i < list.length; ++i) {
            queue.push(list[i]);
        }
    }
    return newlyAdded;
};


/***/ },

/***/ 235
(__unused_webpack_module, exports, __webpack_require__) {


var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.createReactMemoryScan = createReactMemoryScan;
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
const react_memory_scan_1 = __importDefault(__webpack_require__(282));
// import { DOMVisualizationExtension } from './extensions/dom-visualization-extension';
function createReactMemoryScan(options = {}) {
    return new react_memory_scan_1.default(options);
    // const memoryScan = new ReactMemoryScan(options);
    // const domVisualizer = new DOMVisualizationExtension(memoryScan);
    // memoryScan.registerExtension(domVisualizer);
    // return memoryScan;
}


/***/ },

/***/ 282
(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _ReactMemoryScan_instances, _ReactMemoryScan_elementWeakRefs, _ReactMemoryScan_isActivated, _ReactMemoryScan_intervalId, _ReactMemoryScan_elementToBoundingRects, _ReactMemoryScan_elementToComponentStack, _ReactMemoryScan_knownFiberNodes, _ReactMemoryScan_fiberAnalyzer, _ReactMemoryScan_isDevMode, _ReactMemoryScan_subscribers, _ReactMemoryScan_extensions, _ReactMemoryScan_scanIntervalMs, _ReactMemoryScan_domObserver, _ReactMemoryScan_eventListenerTracker, _ReactMemoryScan_isDisposed, _ReactMemoryScan_log, _ReactMemoryScan_notifySubscribers, _ReactMemoryScan_notifyExtensionsBeforeScan, _ReactMemoryScan_notifyExtensionsAfterScan, _ReactMemoryScan_scanCycle, _ReactMemoryScan_updateElementToComponentInfo, _ReactMemoryScan_getTrackedDOMRefs, _ReactMemoryScan_runGC, _ReactMemoryScan_scanEventListenerLeaks;
Object.defineProperty(exports, "__esModule", ({ value: true }));
const utils = __importStar(__webpack_require__(476));
const react_fiber_analysis_1 = __importDefault(__webpack_require__(302));
const react_fiber_utils_1 = __webpack_require__(737);
const dom_observer_1 = __webpack_require__(54);
const config_1 = __webpack_require__(346);
const event_listener_tracker_1 = __webpack_require__(953);
class ReactMemoryScan {
    constructor(options = {}) {
        var _a, _b, _c, _d;
        _ReactMemoryScan_instances.add(this);
        _ReactMemoryScan_elementWeakRefs.set(this, void 0);
        _ReactMemoryScan_isActivated.set(this, void 0);
        _ReactMemoryScan_intervalId.set(this, void 0);
        _ReactMemoryScan_elementToBoundingRects.set(this, void 0);
        _ReactMemoryScan_elementToComponentStack.set(this, void 0);
        _ReactMemoryScan_knownFiberNodes.set(this, void 0);
        _ReactMemoryScan_fiberAnalyzer.set(this, void 0);
        _ReactMemoryScan_isDevMode.set(this, void 0);
        _ReactMemoryScan_subscribers.set(this, void 0);
        _ReactMemoryScan_extensions.set(this, void 0);
        _ReactMemoryScan_scanIntervalMs.set(this, void 0);
        _ReactMemoryScan_domObserver.set(this, void 0);
        _ReactMemoryScan_eventListenerTracker.set(this, void 0);
        _ReactMemoryScan_isDisposed.set(this, void 0);
        __classPrivateFieldSet(this, _ReactMemoryScan_elementWeakRefs, [], "f");
        __classPrivateFieldSet(this, _ReactMemoryScan_isActivated, false, "f");
        __classPrivateFieldSet(this, _ReactMemoryScan_elementToBoundingRects, new WeakMap(), "f");
        __classPrivateFieldSet(this, _ReactMemoryScan_elementToComponentStack, new WeakMap(), "f");
        __classPrivateFieldSet(this, _ReactMemoryScan_knownFiberNodes, [], "f");
        __classPrivateFieldSet(this, _ReactMemoryScan_eventListenerTracker, options.trackEventListenerLeaks
            ? event_listener_tracker_1.EventListenerTracker.getInstance()
            : null, "f");
        __classPrivateFieldSet(this, _ReactMemoryScan_intervalId, null, "f");
        __classPrivateFieldSet(this, _ReactMemoryScan_isDisposed, false, "f");
        __classPrivateFieldSet(this, _ReactMemoryScan_fiberAnalyzer, new react_fiber_analysis_1.default(), "f");
        __classPrivateFieldSet(this, _ReactMemoryScan_isDevMode, (_a = options.isDevMode) !== null && _a !== void 0 ? _a : false, "f");
        __classPrivateFieldSet(this, _ReactMemoryScan_subscribers, (_b = options.subscribers) !== null && _b !== void 0 ? _b : [], "f");
        __classPrivateFieldSet(this, _ReactMemoryScan_extensions, (_c = options.extensions) !== null && _c !== void 0 ? _c : [], "f");
        __classPrivateFieldSet(this, _ReactMemoryScan_scanIntervalMs, (_d = options.scanIntervalMs) !== null && _d !== void 0 ? _d : config_1.config.performance.scanIntervalMs, "f");
    }
    subscribe(callback) {
        __classPrivateFieldGet(this, _ReactMemoryScan_subscribers, "f").push(callback);
        return () => this.unsubscribe(callback);
    }
    unsubscribe(callback) {
        __classPrivateFieldSet(this, _ReactMemoryScan_subscribers, __classPrivateFieldGet(this, _ReactMemoryScan_subscribers, "f").filter(cb => cb !== callback), "f");
    }
    registerExtension(extension) {
        __classPrivateFieldGet(this, _ReactMemoryScan_extensions, "f").push(extension);
        return () => this.unregisterExtension(extension);
    }
    unregisterExtension(extension) {
        __classPrivateFieldSet(this, _ReactMemoryScan_extensions, __classPrivateFieldGet(this, _ReactMemoryScan_extensions, "f").filter(e => e !== extension), "f");
    }
    start() {
        if (__classPrivateFieldGet(this, _ReactMemoryScan_isDisposed, "f")) {
            console.warn('[Memory] ReactMemoryScan has been disposed and cannot be started again');
            return;
        }
        __classPrivateFieldSet(this, _ReactMemoryScan_isActivated, true, "f");
        __classPrivateFieldSet(this, _ReactMemoryScan_intervalId, setInterval(__classPrivateFieldGet(this, _ReactMemoryScan_instances, "m", _ReactMemoryScan_scanCycle).bind(this), __classPrivateFieldGet(this, _ReactMemoryScan_scanIntervalMs, "f")), "f");
        if (config_1.config.features.enableMutationObserver) {
            if (__classPrivateFieldGet(this, _ReactMemoryScan_domObserver, "f") == null) {
                __classPrivateFieldSet(this, _ReactMemoryScan_domObserver, new dom_observer_1.DOMObserver(), "f");
                // NOTE: do not update the fiber or component information here
                // with this.#domObserver.register as those elements in the delta
                // list may be unmounted or just attached and their shape and
                // component info is not correct or not set yet
            }
            __classPrivateFieldGet(this, _ReactMemoryScan_domObserver, "f").startMonitoring();
        }
        console.log('[Memory] Tracking React and DOM memory...');
    }
    pause() {
        __classPrivateFieldSet(this, _ReactMemoryScan_isActivated, false, "f");
    }
    stop() {
        __classPrivateFieldSet(this, _ReactMemoryScan_isActivated, false, "f");
        // Clear the interval
        if (__classPrivateFieldGet(this, _ReactMemoryScan_intervalId, "f") !== null) {
            clearInterval(__classPrivateFieldGet(this, _ReactMemoryScan_intervalId, "f"));
            __classPrivateFieldSet(this, _ReactMemoryScan_intervalId, null, "f");
        }
        // Clear element references to allow garbage collection
        __classPrivateFieldSet(this, _ReactMemoryScan_elementWeakRefs, [], "f");
        __classPrivateFieldSet(this, _ReactMemoryScan_knownFiberNodes, [], "f");
        // Stop DOM observer
        if (__classPrivateFieldGet(this, _ReactMemoryScan_domObserver, "f")) {
            __classPrivateFieldGet(this, _ReactMemoryScan_domObserver, "f").stopMonitoring();
            __classPrivateFieldSet(this, _ReactMemoryScan_domObserver, null, "f");
        }
        // Clear WeakMaps to allow garbage collection
        __classPrivateFieldSet(this, _ReactMemoryScan_elementToBoundingRects, new WeakMap(), "f");
        __classPrivateFieldSet(this, _ReactMemoryScan_elementToComponentStack, new WeakMap(), "f");
        console.log('[Memory] ReactMemoryScan stopped');
    }
    dispose() {
        // Stop all monitoring
        this.stop();
        // Clear all subscribers
        __classPrivateFieldSet(this, _ReactMemoryScan_subscribers, [], "f");
        // Clean up all extensions
        for (const extension of __classPrivateFieldGet(this, _ReactMemoryScan_extensions, "f")) {
            if (extension && typeof extension.cleanup === 'function') {
                extension.cleanup();
            }
        }
        __classPrivateFieldSet(this, _ReactMemoryScan_extensions, [], "f");
        // Dispose event listener tracker if it exists
        if (__classPrivateFieldGet(this, _ReactMemoryScan_eventListenerTracker, "f")) {
            __classPrivateFieldGet(this, _ReactMemoryScan_eventListenerTracker, "f").destroy();
            __classPrivateFieldSet(this, _ReactMemoryScan_eventListenerTracker, null, "f");
        }
        // Mark as disposed to prevent reuse
        __classPrivateFieldSet(this, _ReactMemoryScan_isDisposed, true, "f");
        console.log('[Memory] ReactMemoryScan disposed');
    }
    recordBoundingRectangles(elementRefs) {
        for (const elemRef of elementRefs) {
            const element = elemRef.deref();
            if (element == null || __classPrivateFieldGet(this, _ReactMemoryScan_elementToBoundingRects, "f").has(element)) {
                continue;
            }
            const rect = utils.getBoundingClientRect(element);
            if (rect != null) {
                __classPrivateFieldGet(this, _ReactMemoryScan_elementToBoundingRects, "f").set(element, rect);
            }
        }
    }
    getDetachedDOMInfo() {
        var _a;
        const detachedDOMElements = [];
        for (const weakRef of __classPrivateFieldGet(this, _ReactMemoryScan_elementWeakRefs, "f")) {
            const element = weakRef.deref();
            if (element == null || element.isConnected) {
                continue;
            }
            // add a unique id to that detach dom element
            const elem = element;
            if (elem.detachedElementId == null) {
                const elementId = ReactMemoryScan.nextElementId++;
                elem.detachedElementIdStr = `memory-id-${elementId}@`;
                elem.detachedElementId = elementId;
            }
            const componentStack = (_a = __classPrivateFieldGet(this, _ReactMemoryScan_elementToComponentStack, "f").get(element)) !== null && _a !== void 0 ? _a : [];
            detachedDOMElements.push({
                element: weakRef,
                boundingRect: __classPrivateFieldGet(this, _ReactMemoryScan_elementToBoundingRects, "f").get(element),
                componentStack,
            });
        }
        return detachedDOMElements;
    }
    isDevMode() {
        return __classPrivateFieldGet(this, _ReactMemoryScan_isDevMode, "f");
    }
    getCachedComponentName(elementRef) {
        var _a;
        const FALLBACK_NAME = '<Unknown>';
        const element = elementRef.deref();
        if (element == null) {
            return FALLBACK_NAME;
        }
        const componentStack = __classPrivateFieldGet(this, _ReactMemoryScan_elementToComponentStack, "f").get(element);
        if (componentStack == null) {
            return FALLBACK_NAME;
        }
        return (_a = componentStack[0]) !== null && _a !== void 0 ? _a : FALLBACK_NAME;
    }
    updateFiberNodes(fiberNodes) {
        const knownFiberSet = new WeakSet();
        for (const fiberNode of __classPrivateFieldGet(this, _ReactMemoryScan_knownFiberNodes, "f")) {
            const fiber = fiberNode.deref();
            if (fiber != null) {
                knownFiberSet.add(fiber);
            }
        }
        const newFiberSet = new WeakSet();
        for (const fiberNode of fiberNodes) {
            const fiber = fiberNode.deref();
            if (fiber != null) {
                newFiberSet.add(fiber);
            }
        }
        const leakedFibers = [];
        const newExistingFibers = [];
        // clean up and compact the existing fiber node lists
        for (const fiberRef of __classPrivateFieldGet(this, _ReactMemoryScan_knownFiberNodes, "f")) {
            const fiber = fiberRef.deref();
            if (fiber == null) {
                continue;
            }
            if (!newFiberSet.has(fiber)) {
                leakedFibers.push(fiberRef);
            }
            else {
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
        __classPrivateFieldSet(this, _ReactMemoryScan_knownFiberNodes, newExistingFibers, "f");
        __classPrivateFieldGet(this, _ReactMemoryScan_instances, "m", _ReactMemoryScan_log).call(this, 'known fibers: ', __classPrivateFieldGet(this, _ReactMemoryScan_knownFiberNodes, "f").length);
        __classPrivateFieldGet(this, _ReactMemoryScan_instances, "m", _ReactMemoryScan_log).call(this, 'leaked fibers: ', leakedFibers.length);
        return leakedFibers;
    }
    packLeakedFibers(leakedFibers) {
        const ret = [];
        for (const leakedFiber of leakedFibers) {
            ret.push(new LeakedFiber(leakedFiber));
        }
        return ret;
    }
    scan() {
        const start = Date.now();
        __classPrivateFieldGet(this, _ReactMemoryScan_instances, "m", _ReactMemoryScan_runGC).call(this);
        const weakRefList = __classPrivateFieldGet(this, _ReactMemoryScan_elementWeakRefs, "f");
        // TODO: associate elements with URL and other metadata
        const allElements = __classPrivateFieldGet(this, _ReactMemoryScan_instances, "m", _ReactMemoryScan_getTrackedDOMRefs).call(this);
        __classPrivateFieldGet(this, _ReactMemoryScan_instances, "m", _ReactMemoryScan_updateElementToComponentInfo).call(this, allElements);
        this.recordBoundingRectangles(allElements);
        utils.updateWeakRefList(weakRefList, allElements);
        const scanResult = __classPrivateFieldGet(this, _ReactMemoryScan_fiberAnalyzer, "f").scan(weakRefList, __classPrivateFieldGet(this, _ReactMemoryScan_elementToComponentStack, "f"));
        const leakedFibers = this.updateFiberNodes(scanResult.fiberNodes);
        scanResult.leakedFibers = leakedFibers;
        // scan for event listener leaks
        // TODO: show the results in the UI widget
        scanResult.eventListenerLeaks = __classPrivateFieldGet(this, _ReactMemoryScan_instances, "m", _ReactMemoryScan_scanEventListenerLeaks).call(this);
        window.leakedFibers = this.packLeakedFibers(leakedFibers);
        const end = Date.now();
        __classPrivateFieldGet(this, _ReactMemoryScan_instances, "m", _ReactMemoryScan_log).call(this, `scan took ${end - start}ms`);
        return scanResult;
    }
}
_ReactMemoryScan_elementWeakRefs = new WeakMap(), _ReactMemoryScan_isActivated = new WeakMap(), _ReactMemoryScan_intervalId = new WeakMap(), _ReactMemoryScan_elementToBoundingRects = new WeakMap(), _ReactMemoryScan_elementToComponentStack = new WeakMap(), _ReactMemoryScan_knownFiberNodes = new WeakMap(), _ReactMemoryScan_fiberAnalyzer = new WeakMap(), _ReactMemoryScan_isDevMode = new WeakMap(), _ReactMemoryScan_subscribers = new WeakMap(), _ReactMemoryScan_extensions = new WeakMap(), _ReactMemoryScan_scanIntervalMs = new WeakMap(), _ReactMemoryScan_domObserver = new WeakMap(), _ReactMemoryScan_eventListenerTracker = new WeakMap(), _ReactMemoryScan_isDisposed = new WeakMap(), _ReactMemoryScan_instances = new WeakSet(), _ReactMemoryScan_log = function _ReactMemoryScan_log(...args) {
    if (__classPrivateFieldGet(this, _ReactMemoryScan_isDevMode, "f") && config_1.config.features.enableConsoleLogs) {
        utils.consoleLog(...args);
    }
}, _ReactMemoryScan_notifySubscribers = function _ReactMemoryScan_notifySubscribers(result) {
    for (const subscriber of __classPrivateFieldGet(this, _ReactMemoryScan_subscribers, "f")) {
        subscriber(result);
    }
    const duration = result.end - result.start;
    __classPrivateFieldGet(this, _ReactMemoryScan_instances, "m", _ReactMemoryScan_log).call(this, 'duration: ', `${duration} ms`);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { scanner, leakedFibers, fiberNodes } = result, rest = __rest(result, ["scanner", "leakedFibers", "fiberNodes"]);
    __classPrivateFieldGet(this, _ReactMemoryScan_instances, "m", _ReactMemoryScan_log).call(this, rest);
}, _ReactMemoryScan_notifyExtensionsBeforeScan = function _ReactMemoryScan_notifyExtensionsBeforeScan() {
    for (const extension of __classPrivateFieldGet(this, _ReactMemoryScan_extensions, "f")) {
        extension === null || extension === void 0 ? void 0 : extension.beforeScan();
    }
}, _ReactMemoryScan_notifyExtensionsAfterScan = function _ReactMemoryScan_notifyExtensionsAfterScan(result) {
    for (const extension of __classPrivateFieldGet(this, _ReactMemoryScan_extensions, "f")) {
        extension === null || extension === void 0 ? void 0 : extension.afterScan(result);
    }
}, _ReactMemoryScan_scanCycle = function _ReactMemoryScan_scanCycle() {
    if (!__classPrivateFieldGet(this, _ReactMemoryScan_isActivated, "f")) {
        return;
    }
    __classPrivateFieldGet(this, _ReactMemoryScan_instances, "m", _ReactMemoryScan_notifyExtensionsBeforeScan).call(this);
    const start = performance.now();
    const stats = this.scan();
    const end = performance.now();
    // inform subscribers and extensions
    const analysiResult = Object.assign(Object.assign({}, stats), { start,
        end, scanner: this });
    __classPrivateFieldGet(this, _ReactMemoryScan_instances, "m", _ReactMemoryScan_notifySubscribers).call(this, analysiResult);
    __classPrivateFieldGet(this, _ReactMemoryScan_instances, "m", _ReactMemoryScan_notifyExtensionsAfterScan).call(this, analysiResult);
}, _ReactMemoryScan_updateElementToComponentInfo = function _ReactMemoryScan_updateElementToComponentInfo(elements) {
    for (const elemRef of elements) {
        const element = elemRef.deref();
        if (element == null || __classPrivateFieldGet(this, _ReactMemoryScan_elementToComponentStack, "f").has(element)) {
            continue;
        }
        const fiberNode = (0, react_fiber_utils_1.getFiberNodeFromElement)(element);
        if (fiberNode == null) {
            continue;
        }
        __classPrivateFieldGet(this, _ReactMemoryScan_elementToComponentStack, "f").set(element, (0, react_fiber_utils_1.getReactComponentStack)(fiberNode));
    }
}, _ReactMemoryScan_getTrackedDOMRefs = function _ReactMemoryScan_getTrackedDOMRefs() {
    if (__classPrivateFieldGet(this, _ReactMemoryScan_domObserver, "f") == null) {
        return utils.getDOMElements();
    }
    return [...utils.getDOMElements(), ...__classPrivateFieldGet(this, _ReactMemoryScan_domObserver, "f").getDOMElements()];
}, _ReactMemoryScan_runGC = function _ReactMemoryScan_runGC() {
    if ((window === null || window === void 0 ? void 0 : window.gc) != null) {
        window.gc();
    }
}, _ReactMemoryScan_scanEventListenerLeaks = function _ReactMemoryScan_scanEventListenerLeaks() {
    var _a;
    if (__classPrivateFieldGet(this, _ReactMemoryScan_eventListenerTracker, "f") == null) {
        return [];
    }
    // Scan for event listener leaks
    const detachedListeners = __classPrivateFieldGet(this, _ReactMemoryScan_eventListenerTracker, "f").scan(this.getCachedComponentName.bind(this));
    const eventListenerLeaks = [];
    for (const [componentName, listeners] of detachedListeners.entries()) {
        const typeCount = new Map();
        for (const listener of listeners) {
            const count = (_a = typeCount.get(listener.type)) !== null && _a !== void 0 ? _a : 0;
            typeCount.set(listener.type, count + 1);
        }
        for (const [type, count] of typeCount.entries()) {
            eventListenerLeaks.push({
                type,
                componentName,
                count,
            });
        }
    }
    return eventListenerLeaks;
};
ReactMemoryScan.nextElementId = 0;
exports["default"] = ReactMemoryScan;
class LeakedFiber {
    constructor(fiber) {
        this.leakedFiber = fiber;
    }
}


/***/ },

/***/ 302
(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
const utils = __importStar(__webpack_require__(476));
const react_fiber_utils_1 = __webpack_require__(737);
const valid_component_name_1 = __webpack_require__(847);
class ReactFiberAnalyzer {
    scan(elementWeakRefList, elementToComponentStack) {
        var _a;
        const visitedRootFibers = new Set();
        const components = new Set();
        const componentToFiberNodeCount = new Map();
        const detachedComponentToFiberNodeCount = new Map();
        const topDownVisited = new Set();
        const analyzedFibers = new Set();
        const fiberNodes = [];
        let totalElements = 0;
        let totalDetachedElements = 0;
        function analyzeFiber(fiberNode) {
            (0, react_fiber_utils_1.traverseFiber)(fiberNode, (fiberNode) => {
                // skip if the fiber node has already been analyzed
                if (analyzedFibers.has(fiberNode)) {
                    return true;
                }
                analyzedFibers.add(fiberNode);
                // traverse the fiber tree up to find the component name
                const displayName = (0, react_fiber_utils_1.getDisplayNameOfFiberNode)(fiberNode);
                if (displayName != null && (0, valid_component_name_1.isValidComponentName)(displayName)) {
                    components.add(displayName);
                    utils.addCountbyKey(componentToFiberNodeCount, displayName, 1);
                    return true;
                }
            }, true);
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
                if (elementToComponentStack.has(elem)) {
                    const componentStack = (_a = elementToComponentStack.get(elem)) !== null && _a !== void 0 ? _a : [];
                    // set component name
                    const component = componentStack[0];
                    elem.__component_name = component;
                    utils.addCountbyKey(detachedComponentToFiberNodeCount, component, 1);
                }
                ++totalDetachedElements;
            }
            // analyze fiber nodes
            const fiberNode = (0, react_fiber_utils_1.getFiberNodeFromElement)(elem);
            if (fiberNode == null) {
                continue;
            }
            analyzeFiber(fiberNode);
            // try to traverse each fiber node in the entire fiber tree
            const rootFiber = (0, react_fiber_utils_1.getTopMostFiberWithChild)(fiberNode);
            if (rootFiber == null) {
                continue;
            }
            if (visitedRootFibers.has(rootFiber)) {
                continue;
            }
            visitedRootFibers.add(rootFiber);
            // start traversing fiber tree from the know root host
            (0, react_fiber_utils_1.traverseFiber)(rootFiber, (node) => {
                if (topDownVisited.has(node)) {
                    return true;
                }
                topDownVisited.add(node);
                fiberNodes.push(new WeakRef(node));
                analyzeFiber(node);
            }, false);
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
exports["default"] = ReactFiberAnalyzer;


/***/ },

/***/ 313
(__unused_webpack_module, exports) {


/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
var _a, _b, _c;
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.WeakMapPlus = exports.WeakMapNoOp = exports.WeakSetNoOp = exports.WeakRefNoOp = void 0;
exports.getNativeWeakMap = getNativeWeakMap;
exports.getNativeWeakMapOrFallback = getNativeWeakMapOrFallback;
exports.getNativeWeakSet = getNativeWeakSet;
exports.getNativeWeakSetOrFallback = getNativeWeakSetOrFallback;
exports.getNativeWeakRef = getNativeWeakRef;
exports.getNativeWeakRefOrFallback = getNativeWeakRefOrFallback;
exports.isWeakMapNative = isWeakMapNative;
exports.isWeakSetNative = isWeakSetNative;
exports.isWeakRefNative = isWeakRefNative;
exports.isWeakAPINative = isWeakAPINative;
const globalScope = typeof window !== 'undefined' ? window : self;
const _weakMap = (_a = globalScope.WeakMap) !== null && _a !== void 0 ? _a : null;
const _weakMapIsNative = isWeakMapNative();
const _weakSet = (_b = globalScope.WeakSet) !== null && _b !== void 0 ? _b : null;
const _weakSetIsNative = isWeakSetNative();
const _weakRef = (_c = globalScope.WeakRef) !== null && _c !== void 0 ? _c : null;
const _weakRefIsNative = isWeakRefNative();
const _weakAPIsAreNative = _weakMapIsNative && _weakSetIsNative && _weakRefIsNative;
class WeakRefNoOp {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_targetObject) {
        // to be overridden
    }
    deref() {
        return undefined;
    }
}
exports.WeakRefNoOp = WeakRefNoOp;
class WeakSetNoOp {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_iterable) {
        // to be overridden
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    add(_value) {
        return this;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    delete(_value) {
        return false;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    has(_value) {
        return false;
    }
}
exports.WeakSetNoOp = WeakSetNoOp;
class WeakMapNoOp {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_iterable) {
        // to be overridden
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    delete(_key) {
        return false;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    get(_key) {
        return undefined;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    has(_key) {
        return false;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    set(_key, _value) {
        return this;
    }
}
exports.WeakMapNoOp = WeakMapNoOp;
function getNativeWeakMap() {
    return _weakMapIsNative ? _weakMap : null;
}
function getNativeWeakMapOrFallback() {
    return _weakMapIsNative && _weakMap ? _weakMap : WeakMapNoOp;
}
function getNativeWeakSet() {
    return _weakSetIsNative ? _weakSet : null;
}
function getNativeWeakSetOrFallback() {
    return _weakSetIsNative && _weakSet ? _weakSet : WeakSetNoOp;
}
function getNativeWeakRef() {
    return _weakRefIsNative ? _weakRef : null;
}
function getNativeWeakRefOrFallback() {
    return _weakRefIsNative && _weakRef ? _weakRef : WeakRefNoOp;
}
function normalize(input) {
    return typeof input.replace === 'function'
        ? input.replace(/\n/g, ' ').replace(/\s+/g, ' ')
        : null;
}
function isWeakMapNative() {
    return (_weakMap !== null &&
        typeof _weakMap.toString === 'function' &&
        normalize(_weakMap.toString()) === 'function WeakMap() { [native code] }');
}
function isWeakSetNative() {
    return (_weakSet !== null &&
        typeof _weakSet.toString === 'function' &&
        normalize(_weakSet.toString()) === 'function WeakSet() { [native code] }');
}
function isWeakRefNative() {
    return (_weakRef !== null &&
        typeof _weakRef.toString === 'function' &&
        normalize(_weakRef.toString()) === 'function WeakRef() { [native code] }');
}
function isWeakAPINative() {
    return _weakAPIsAreNative;
}
class WeakMapPlus {
    constructor(options = {}) {
        this.strongMap = null;
        this.noopMap = false;
        this.entriesMap = new Map();
        this.keyToId = new WeakMap();
        const { fallback = 'strong', cleanupMs = 1000 } = options;
        this.isWeak = _weakAPIsAreNative;
        this.fallbackMode = fallback;
        if (!this.isWeak) {
            if (fallback === 'strong') {
                this.strongMap = new Map();
            }
            else if (fallback === 'noop') {
                this.noopMap = true;
            }
            this.cleanupInterval = -1;
        }
        else {
            this.cleanupInterval = setInterval(() => this.cleanup(), cleanupMs);
        }
    }
    getOrCreateId(key) {
        let id = this.keyToId.get(key);
        if (!id) {
            id = Symbol();
            this.keyToId.set(key, id);
        }
        return id;
    }
    set(key, value) {
        var _a;
        if (!this.isWeak) {
            if (this.noopMap)
                return this;
            (_a = this.strongMap) === null || _a === void 0 ? void 0 : _a.set(key, value);
            return this;
        }
        const id = this.getOrCreateId(key);
        this.entriesMap.set(id, { ref: new WeakRef(key), value });
        return this;
    }
    get(key) {
        var _a, _b;
        if (!this.isWeak) {
            if (this.noopMap)
                return undefined;
            return (_a = this.strongMap) === null || _a === void 0 ? void 0 : _a.get(key);
        }
        const id = this.keyToId.get(key);
        if (!id)
            return undefined;
        const entry = this.entriesMap.get(id);
        const derefKey = (_b = entry === null || entry === void 0 ? void 0 : entry.ref) === null || _b === void 0 ? void 0 : _b.deref();
        return derefKey ? entry === null || entry === void 0 ? void 0 : entry.value : undefined;
    }
    has(key) {
        var _a, _b;
        if (!this.isWeak) {
            if (this.noopMap)
                return false;
            return (_b = (_a = this.strongMap) === null || _a === void 0 ? void 0 : _a.has(key)) !== null && _b !== void 0 ? _b : false;
        }
        const id = this.keyToId.get(key);
        if (!id)
            return false;
        const entry = this.entriesMap.get(id);
        return !!(entry && entry.ref.deref());
    }
    delete(key) {
        var _a, _b;
        if (!this.isWeak) {
            if (this.noopMap)
                return false;
            return (_b = (_a = this.strongMap) === null || _a === void 0 ? void 0 : _a.delete(key)) !== null && _b !== void 0 ? _b : false;
        }
        const id = this.keyToId.get(key);
        if (!id)
            return false;
        this.keyToId.delete(key);
        return this.entriesMap.delete(id);
    }
    *liveEntries() {
        for (const [, entry] of this.entriesMap) {
            const key = entry.ref.deref();
            if (key) {
                yield [key, entry.value];
            }
        }
    }
    entries() {
        var _a, _b;
        if (!this.isWeak) {
            if (this.noopMap)
                return [][Symbol.iterator]();
            return (_b = (_a = this.strongMap) === null || _a === void 0 ? void 0 : _a.entries()) !== null && _b !== void 0 ? _b : [][Symbol.iterator]();
        }
        return this.liveEntries();
    }
    keys() {
        return (function* (self) {
            for (const [key] of self.entries())
                yield key;
        })(this);
    }
    values() {
        return (function* (self) {
            for (const [, value] of self.entries())
                yield value;
        })(this);
    }
    [Symbol.iterator]() {
        return this.entries();
    }
    get size() {
        var _a, _b;
        if (!this.isWeak) {
            if (this.noopMap)
                return 0;
            return (_b = (_a = this.strongMap) === null || _a === void 0 ? void 0 : _a.size) !== null && _b !== void 0 ? _b : 0;
        }
        let count = 0;
        // eslint-disable-next-line
        for (const _ of this.liveEntries()) {
            count++;
        }
        return count;
    }
    getFallbackMode() {
        return this.fallbackMode;
    }
    cleanup() {
        if (!this.isWeak)
            return;
        for (const [id, entry] of this.entriesMap) {
            if (!entry.ref.deref()) {
                this.entriesMap.delete(id);
            }
        }
    }
    destroy() {
        if (this.isWeak) {
            clearInterval(this.cleanupInterval);
        }
    }
}
exports.WeakMapPlus = WeakMapPlus;


/***/ },

/***/ 346
(__unused_webpack_module, exports) {


/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.config = exports.featureFlags = exports.performanceConfig = void 0;
// Performance Configuration
exports.performanceConfig = {
    scanIntervalMs: 1000,
    maxComponentStackDepth: 100,
    memoryMeasurementIntervalMs: 5000,
};
// Feature Flags
exports.featureFlags = {
    enableMutationObserver: true,
    enableMemoryTracking: true,
    enableComponentStack: true,
    enableConsoleLogs: window === null || window === void 0 ? void 0 : window.TEST_MEMORY_SCAN,
};
// overall Config
exports.config = {
    performance: exports.performanceConfig,
    features: exports.featureFlags,
};


/***/ },

/***/ 476
(__unused_webpack_module, exports, __webpack_require__) {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.getDOMElements = getDOMElements;
exports.getDOMElementCount = getDOMElementCount;
exports.getMeaningfulName = getMeaningfulName;
exports.isMinifiedName = isMinifiedName;
exports.addCountbyKey = addCountbyKey;
exports.updateWeakRefList = updateWeakRefList;
exports.getBoundingClientRect = getBoundingClientRect;
exports.consoleLog = consoleLog;
exports.hasRunInSession = hasRunInSession;
exports.setRunInSession = setRunInSession;
const visual_utils_1 = __webpack_require__(498);
function getDOMElements() {
    const elements = Array.from(document.querySelectorAll('*'));
    const ret = [];
    for (const element of elements) {
        if ((0, visual_utils_1.isVisualizerElement)(element)) {
            continue;
        }
        ret.push(new WeakRef(element));
    }
    return ret;
}
function getDOMElementCount() {
    const elements = Array.from(document.querySelectorAll('*'));
    let ret = 0;
    for (const element of elements) {
        if ((0, visual_utils_1.isVisualizerElement)(element)) {
            continue;
        }
        ++ret;
    }
    return ret;
}
function getMeaningfulName(name) {
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
function isMinifiedName(name) {
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
    const hasMeaningfulPattern = /^[A-Z][a-z]+([A-Z][a-z]*)*$|^[a-z]+([A-Z][a-z]*)*$/.test(name);
    return !hasMeaningfulPattern;
}
function addCountbyKey(map, key, count) {
    var _a;
    map.set(key, ((_a = map.get(key)) !== null && _a !== void 0 ? _a : 0) + count);
}
function updateWeakRefList(weakRefList, elementRefs) {
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
function getElementsSet(weakRefList) {
    const set = new Set();
    for (const weakRef of weakRefList) {
        set.add(weakRef.deref());
    }
    return set;
}
function consolidateWeakRefList(weakRefList) {
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
function getBoundingClientRect(element) {
    if (element == null) {
        return null;
    }
    if (typeof element.getBoundingClientRect !== 'function') {
        return null;
    }
    let rect = null;
    try {
        rect = element.getBoundingClientRect();
    }
    catch (_a) {
        // do nothing
    }
    if (rect == null) {
        return null;
    }
    const scrollTop = window.scrollY;
    const scrollLeft = window.scrollX;
    const ret = {};
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
    return ret;
}
const _console = console;
const _consoleLog = _console.log;
function consoleLog(...args) {
    _consoleLog.apply(_console, args);
}
const SESSION_STORAGE_KEY = 'memory_lens_session';
function isSessionStorageAvailable() {
    try {
        const testKey = '__memory_lens_session_test__';
        sessionStorage.setItem(testKey, '1');
        sessionStorage.removeItem(testKey);
        return true;
    }
    catch (_a) {
        return false;
    }
}
function hasRunInSession() {
    if (!isSessionStorageAvailable()) {
        return false;
    }
    try {
        return sessionStorage.getItem(SESSION_STORAGE_KEY) === 'true';
    }
    catch (_a) {
        return false;
    }
}
function setRunInSession() {
    if (!isSessionStorageAvailable()) {
        return;
    }
    try {
        sessionStorage.setItem(SESSION_STORAGE_KEY, 'true');
    }
    catch (_a) {
        // do nothing
    }
}


/***/ },

/***/ 498
(__unused_webpack_module, exports) {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.isVisualizerElement = isVisualizerElement;
exports.createVisualizerElement = createVisualizerElement;
exports.tryToAttachOverlay = tryToAttachOverlay;
exports.addTrackedListener = addTrackedListener;
exports.removeAllListeners = removeAllListeners;
exports.debounce = debounce;
const VISUALIZER_DATA_ATTR = 'data-visualizer';
function setVisualizerElement(element) {
    element.setAttribute(VISUALIZER_DATA_ATTR, 'true');
    element.setAttribute('data-visualcompletion', 'ignore');
}
function isVisualizerElement(element) {
    return element.getAttribute(VISUALIZER_DATA_ATTR) === 'true';
}
function createVisualizerElement(tag) {
    const element = document.createElement(tag);
    setVisualizerElement(element);
    return element;
}
function tryToAttachOverlay(overlayDiv) {
    if (document.body) {
        document.body.appendChild(overlayDiv);
    }
}
const listenerMap = new WeakMap();
function addTrackedListener(elRef, type, cb, options) {
    var _a;
    const el = elRef.deref();
    if (!el)
        return;
    el.addEventListener(type, cb, options);
    if (!listenerMap.has(el)) {
        listenerMap.set(el, []);
    }
    (_a = listenerMap.get(el)) === null || _a === void 0 ? void 0 : _a.push({ type, cb, options });
}
function removeAllListeners(elRef) {
    const el = elRef.deref();
    if (!el)
        return;
    const listeners = listenerMap.get(el);
    if (!listeners)
        return;
    for (const { type, cb, options } of listeners) {
        el.removeEventListener(type, cb, options);
    }
    listenerMap.delete(el);
}
function debounce(callback, delay) {
    let timer = null;
    return (...args) => {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            callback(...args);
        }, delay);
    };
}


/***/ },

/***/ 737
(__unused_webpack_module, exports, __webpack_require__) {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.traverseFiber = exports.getTopMostFiberWithChild = exports.getTopMostHostFiber = exports.getNearestHostFiber = exports.isHostFiber = exports.MutationMask = exports.Visibility = exports.Snapshot = exports.Ref = exports.ContentReset = exports.ChildDeletion = exports.Cloned = exports.Update = exports.Hydrating = exports.DidCapture = exports.Placement = exports.PerformedWork = exports.DEPRECATED_ASYNC_MODE_SYMBOL_STRING = exports.CONCURRENT_MODE_SYMBOL_STRING = exports.CONCURRENT_MODE_NUMBER = exports.HostRoot = exports.OffscreenComponent = exports.LegacyHiddenComponent = exports.Fragment = exports.HostText = exports.DehydratedSuspenseComponent = exports.HostSingletonTag = exports.HostHoistableTag = exports.HostComponentTag = exports.SimpleMemoComponentTag = exports.MemoComponentTag = exports.ForwardRefTag = exports.OffscreenComponentTag = exports.SuspenseComponentTag = exports.ContextConsumerTag = exports.FunctionComponentTag = exports.ClassComponentTag = void 0;
exports.getFiberNodeFromElement = getFiberNodeFromElement;
exports.getReactComponentStack = getReactComponentStack;
exports.getDisplayNameOfFiberNode = getDisplayNameOfFiberNode;
exports.isFunctionalComponent = isFunctionalComponent;
exports.extractReactComponentName = extractReactComponentName;
const utils_1 = __webpack_require__(476);
const valid_component_name_1 = __webpack_require__(847);
exports.ClassComponentTag = 1;
exports.FunctionComponentTag = 0;
exports.ContextConsumerTag = 9;
exports.SuspenseComponentTag = 13;
exports.OffscreenComponentTag = 22;
exports.ForwardRefTag = 11;
exports.MemoComponentTag = 14;
exports.SimpleMemoComponentTag = 15;
exports.HostComponentTag = 5;
exports.HostHoistableTag = 26;
exports.HostSingletonTag = 27;
exports.DehydratedSuspenseComponent = 18;
exports.HostText = 6;
exports.Fragment = 7;
exports.LegacyHiddenComponent = 23;
exports.OffscreenComponent = 22;
exports.HostRoot = 3;
exports.CONCURRENT_MODE_NUMBER = 0xeacf;
exports.CONCURRENT_MODE_SYMBOL_STRING = 'Symbol(react.concurrent_mode)';
exports.DEPRECATED_ASYNC_MODE_SYMBOL_STRING = 'Symbol(react.async_mode)';
// https://github.com/facebook/react/blob/main/packages/react-reconciler/src/ReactFiberFlags.js
exports.PerformedWork = 0b1;
exports.Placement = 0b10;
exports.DidCapture = 0b10000000;
exports.Hydrating = 0b1000000000000;
exports.Update = 0b100;
exports.Cloned = 0b1000;
exports.ChildDeletion = 0b10000;
exports.ContentReset = 0b100000;
exports.Ref = 0b1000000000;
exports.Snapshot = 0b10000000000;
exports.Visibility = 0b10000000000000;
exports.MutationMask = exports.Placement |
    exports.Update |
    exports.ChildDeletion |
    exports.ContentReset |
    exports.Hydrating |
    exports.Visibility |
    exports.Snapshot;
/**
 * @see https://reactnative.dev/architecture/glossary#host-view-tree-and-host-view
 */
const isHostFiber = (fiber) => fiber.tag === exports.HostComponentTag ||
    // @ts-expect-error: it exists
    fiber.tag === exports.HostHoistableTag ||
    // @ts-expect-error: it exists
    fiber.tag === exports.HostSingletonTag ||
    typeof fiber.type === 'string';
exports.isHostFiber = isHostFiber;
const getNearestHostFiber = (fiber) => {
    let hostFiber = (0, exports.traverseFiber)(fiber, exports.isHostFiber);
    if (!hostFiber) {
        hostFiber = (0, exports.traverseFiber)(fiber, exports.isHostFiber, true);
    }
    return hostFiber;
};
exports.getNearestHostFiber = getNearestHostFiber;
const getTopMostHostFiber = (fiber) => {
    let topMostHostFiber = null;
    function checkFiber(fiber) {
        if ((0, exports.isHostFiber)(fiber)) {
            topMostHostFiber = fiber;
        }
    }
    (0, exports.traverseFiber)(fiber, checkFiber, true);
    return topMostHostFiber;
};
exports.getTopMostHostFiber = getTopMostHostFiber;
const getTopMostFiberWithChild = (fiber) => {
    let topMostFiber = null;
    function checkFiber(fiber) {
        if (fiber.child != null) {
            topMostFiber = fiber;
        }
    }
    (0, exports.traverseFiber)(fiber, checkFiber, true);
    return topMostFiber;
};
exports.getTopMostFiberWithChild = getTopMostFiberWithChild;
const traverseFiber = (fiber, selector, ascending = false) => {
    if (!fiber) {
        return null;
    }
    if (selector(fiber) === true) {
        return fiber;
    }
    let next = ascending ? fiber.return : fiber.child;
    while (next) {
        const match = (0, exports.traverseFiber)(next, selector, ascending);
        if (match) {
            return match;
        }
        next = ascending ? null : next.sibling;
    }
    return null;
};
exports.traverseFiber = traverseFiber;
// React internal property keys
const internalKeys = [
    '__reactFiber$', // React 17+
    '__reactInternalInstance$', // React 16
    '_reactRootContainer', // React Root
];
const getOwnPropertyNames = Object.getOwnPropertyNames.bind(Object);
function getFiberNodeFromElement(element) {
    for (const prefix of internalKeys) {
        // Use Object.keys only as fallback since it's slower
        const key = getOwnPropertyNames(element).find(k => k.startsWith(prefix));
        if (key) {
            return element[key];
        }
    }
    return null;
}
function getReactComponentStack(node) {
    const stack = [];
    const visited = new Set();
    let fiber = node;
    while (fiber) {
        if (visited.has(fiber)) {
            break;
        }
        visited.add(fiber);
        const name = getDisplayNameOfFiberNode(fiber);
        if (name) {
            stack.push(name);
        }
        fiber = fiber.return;
    }
    return stack;
}
function getDisplayNameOfFiberNode(node) {
    var _a, _b, _c, _d;
    const elementType = (_a = node.type) !== null && _a !== void 0 ? _a : node.elementType;
    // Try to get name from displayName or name properties
    let displayName = (_b = elementType === null || elementType === void 0 ? void 0 : elementType.displayName) !== null && _b !== void 0 ? _b : elementType === null || elementType === void 0 ? void 0 : elementType.name;
    // Handle class components and forwardRef
    if (displayName == null) {
        if (elementType === null || elementType === void 0 ? void 0 : elementType.render) {
            // Class components
            const render = elementType === null || elementType === void 0 ? void 0 : elementType.render;
            displayName = (_c = render === null || render === void 0 ? void 0 : render.displayName) !== null && _c !== void 0 ? _c : render === null || render === void 0 ? void 0 : render.name;
        }
        else if (elementType === null || elementType === void 0 ? void 0 : elementType.type) {
            // ForwardRef components
            displayName = (_d = elementType.type.displayName) !== null && _d !== void 0 ? _d : elementType.type.name;
        }
    }
    // Handle anonymous functions
    if (!displayName && typeof elementType === 'function') {
        displayName = elementType.name;
    }
    const ret = (0, utils_1.getMeaningfulName)(extractReactComponentName(displayName));
    return (0, valid_component_name_1.isValidComponentName)(ret) ? ret : null;
}
function isFunctionalComponent(node) {
    const elementType = node === null || node === void 0 ? void 0 : node.elementType;
    return typeof elementType === 'function';
}
// dom-element [from component.react] --> component.react
function extractReactComponentName(displayName) {
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


/***/ },

/***/ 847
(__unused_webpack_module, exports) {


/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.isValidComponentName = isValidComponentName;
const displayNameBlockList = new Set();
function isValidComponentName(name) {
    return name != null && !displayNameBlockList.has(name);
}


/***/ },

/***/ 953
(__unused_webpack_module, exports, __webpack_require__) {


var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _EventListenerTracker_instances, _EventListenerTracker_listenerMap, _EventListenerTracker_detachedListeners, _EventListenerTracker_originalAddEventListener, _EventListenerTracker_originalRemoveEventListener, _EventListenerTracker_patchEventListeners, _EventListenerTracker_unpatchEventListeners;
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.EventListenerTracker = void 0;
const react_fiber_utils_1 = __webpack_require__(737);
const weak_ref_utils_1 = __webpack_require__(313);
class EventListenerTracker {
    constructor() {
        _EventListenerTracker_instances.add(this);
        _EventListenerTracker_listenerMap.set(this, void 0);
        _EventListenerTracker_detachedListeners.set(this, void 0);
        _EventListenerTracker_originalAddEventListener.set(this, void 0);
        _EventListenerTracker_originalRemoveEventListener.set(this, void 0);
        __classPrivateFieldSet(this, _EventListenerTracker_listenerMap, new weak_ref_utils_1.WeakMapPlus({ fallback: 'noop', cleanupMs: 100 }), "f");
        __classPrivateFieldSet(this, _EventListenerTracker_detachedListeners, new Map(), "f");
        __classPrivateFieldSet(this, _EventListenerTracker_originalAddEventListener, EventTarget.prototype.addEventListener, "f");
        __classPrivateFieldSet(this, _EventListenerTracker_originalRemoveEventListener, EventTarget.prototype.removeEventListener, "f");
        __classPrivateFieldGet(this, _EventListenerTracker_instances, "m", _EventListenerTracker_patchEventListeners).call(this);
    }
    static getInstance() {
        if (!EventListenerTracker.instance) {
            EventListenerTracker.instance = new EventListenerTracker();
        }
        return EventListenerTracker.instance;
    }
    addListener(el, type, cb, options) {
        el.addEventListener(type, cb, options);
    }
    removeListener(el, type, cb, options) {
        el.removeEventListener(type, cb, options);
    }
    scan(getComponentName) {
        const detachedListeners = new Map();
        for (const [el, listeners] of __classPrivateFieldGet(this, _EventListenerTracker_listenerMap, "f").entries()) {
            if (el instanceof Element && !el.isConnected) {
                for (const listener of listeners) {
                    // Skip if the callback has been garbage collected
                    if (!listener.cb.deref())
                        continue;
                    const componentName = getComponentName(new WeakRef(el));
                    if (!detachedListeners.has(componentName)) {
                        detachedListeners.set(componentName, []);
                    }
                    const groups = detachedListeners.get(componentName);
                    let group = groups === null || groups === void 0 ? void 0 : groups.find(g => g.type === listener.type);
                    if (!group) {
                        group = {
                            type: listener.type,
                            count: 0,
                            entries: [],
                        };
                        groups === null || groups === void 0 ? void 0 : groups.push(group);
                    }
                    group.count++;
                    group.entries.push(new WeakRef(listener));
                }
            }
        }
        __classPrivateFieldSet(this, _EventListenerTracker_detachedListeners, detachedListeners, "f");
        return detachedListeners;
    }
    getDetachedListeners() {
        return __classPrivateFieldGet(this, _EventListenerTracker_detachedListeners, "f");
    }
    destroy() {
        __classPrivateFieldGet(this, _EventListenerTracker_instances, "m", _EventListenerTracker_unpatchEventListeners).call(this);
        __classPrivateFieldGet(this, _EventListenerTracker_listenerMap, "f").destroy();
        __classPrivateFieldGet(this, _EventListenerTracker_detachedListeners, "f").clear();
        EventListenerTracker.instance = null;
    }
}
exports.EventListenerTracker = EventListenerTracker;
_EventListenerTracker_listenerMap = new WeakMap(), _EventListenerTracker_detachedListeners = new WeakMap(), _EventListenerTracker_originalAddEventListener = new WeakMap(), _EventListenerTracker_originalRemoveEventListener = new WeakMap(), _EventListenerTracker_instances = new WeakSet(), _EventListenerTracker_patchEventListeners = function _EventListenerTracker_patchEventListeners() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
        var _a;
        __classPrivateFieldGet(self, _EventListenerTracker_originalAddEventListener, "f").call(this, type, listener, options);
        if (this instanceof Element) {
            const fiber = (0, react_fiber_utils_1.getFiberNodeFromElement)(this);
            const entry = {
                type,
                cb: new WeakRef(listener),
                options,
                fiber: fiber ? new WeakRef(fiber) : undefined,
            };
            const listeners = (_a = __classPrivateFieldGet(self, _EventListenerTracker_listenerMap, "f").get(this)) !== null && _a !== void 0 ? _a : [];
            listeners.push(entry);
            __classPrivateFieldGet(self, _EventListenerTracker_listenerMap, "f").set(this, listeners);
        }
    };
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
        __classPrivateFieldGet(self, _EventListenerTracker_originalRemoveEventListener, "f").call(this, type, listener, options);
        if (this instanceof Element) {
            const listeners = __classPrivateFieldGet(self, _EventListenerTracker_listenerMap, "f").get(this);
            if (listeners) {
                const index = listeners.findIndex(entry => entry.type === type &&
                    entry.cb.deref() === listener &&
                    entry.options === options);
                if (index !== -1) {
                    listeners.splice(index, 1);
                }
                if (listeners.length === 0) {
                    __classPrivateFieldGet(self, _EventListenerTracker_listenerMap, "f").delete(this);
                }
                else {
                    __classPrivateFieldGet(self, _EventListenerTracker_listenerMap, "f").set(this, listeners);
                }
            }
        }
    };
}, _EventListenerTracker_unpatchEventListeners = function _EventListenerTracker_unpatchEventListeners() {
    EventTarget.prototype.addEventListener = __classPrivateFieldGet(this, _EventListenerTracker_originalAddEventListener, "f");
    EventTarget.prototype.removeEventListener =
        __classPrivateFieldGet(this, _EventListenerTracker_originalRemoveEventListener, "f");
};
EventListenerTracker.instance = null;


/***/ }

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __webpack_require__(235);
/******/ 	
/******/ 	return __webpack_exports__;
/******/ })()
;
});