/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import {Fiber} from 'react-reconciler';
import type {BasicExtension} from '../extensions/basic-extension';
import type ReactMemoryScan from './react-memory-scan';

/** @internal */
export type AnyValue = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** @internal */
export type ObjectValue = {[key: string]: AnyValue};

/** @internal */
export type RecordValue =
  | string
  | number
  | boolean
  | null
  | RecordValue[]
  | {[key: string]: RecordValue};

/**
 * Given any type `T`, return the union type `T` and `null`
 * @typeParam T - The type that will be made nullable.
 */
export type Nullable<T> = T | null;

/**
 * Given any type `T`, return the union type `T`, `null`, and `undefined`.
 * @typeParam T - The type that will be made both nullable and undefinable.
 */
export type Optional<T> = T | null | undefined;

/**
 * Given any type `T`, return the union type `T` and `undefined`.
 * @typeParam T - The type that will be made undefinable.
 */
export type Undefinable<T> = T | undefined;

/** @internal */
export type AnyRecord = Record<string, RecordValue>;
/** @internal */
export type StringRecord = Record<string, string>;

/**
 * Options for creating a ReactMemoryScan instance
 * @property {boolean} [isDevMode] - When true, enables dev mode features
 */
export type CreateOptions = {
  isDevMode?: boolean;
  subscribers?: Array<AnalysisResultCallback>;
  extensions?: Array<BasicExtension>;
  scanIntervalMs?: number;
};

/**
 * Result of scanning react fiber tree and DOM elements
 * @property {Set<string>} components - Set of component names found in the fiber tree
 * @property {Map<string, number>} componentToFiberNodeCount - Map of component names to their instance counts
 * @property {number} totalElements - Total number of DOM elements found
 * @property {number} totalDetachedElements - Number of detached DOM elements found
 * @property {Map<string, number>} detachedComponentToFiberNodeCount - Map of component names to their detached instance counts
 */
export type ScanResult = {
  components: Set<string>;
  componentToFiberNodeCount: Map<string, number>;
  totalElements: number;
  totalDetachedElements: number;
  detachedComponentToFiberNodeCount: Map<string, number>;
  fiberNodes: Array<WeakRef<Fiber>>;
  leakedFibers: Array<WeakRef<Fiber>>;
};

/**
 * Result of analyzing React fiber nodes and DOM elements
 * @property {number} start - Start time of the analysis
 * @property {number} end - End time of the analysis
 */
export type AnalysisResult = ScanResult & {
  start: number;
  end: number;
  scanner: ReactMemoryScan;
};

/**
 * Callback function type for analysis results
 * @param {AnalysisResult} result - The analysis result
 */
export type AnalysisResultCallback = (result: AnalysisResult) => void;

/**
 * Represents the dimensions and position of an element's bounding box
 * @property {number} x - The x-coordinate of the element's left edge relative to the viewport
 * @property {number} y - The y-coordinate of the element's top edge relative to the viewport
 * @property {number} width - The width of the element's bounding box
 * @property {number} height - The height of the element's bounding box
 * @property {number} top - The distance from the top of the viewport to the element's top edge
 * @property {number} right - The distance from the left of the viewport to the element's right edge
 * @property {number} bottom - The distance from the top of the viewport to the element's bottom edge
 * @property {number} left - The distance from the left of the viewport to the element's left edge
 */
export interface BoundingRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Represents information about a DOM element
 * @property {WeakRef<Element>} element - A weak reference to the DOM element
 * @property {Optional<BoundingRect>} boundingRect - The bounding rectangle of the element
 * @property {Optional<string>} component - The react component name associated with the element
 */
export type DOMElementInfo = {
  element: WeakRef<Element>;
  boundingRect: Optional<BoundingRect>;
  component: Optional<string>;
};

/** @internal */
export type DOMElementStats = {
  elements: number;
  detachedElements: number;
};

export type DOMObserveCallback = (list: Array<WeakRef<Element>>) => void;
