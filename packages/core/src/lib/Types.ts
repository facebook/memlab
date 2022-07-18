/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import {ParsedArgs} from 'minimist';
import type {LaunchOptions, Page} from 'puppeteer';
import type {ErrorHandling, MemLabConfig} from './Config';

/** @internal */
export type AnyValue = any;

/** @internal */
export type RecordValue =
  | string
  | number
  | boolean
  | null
  | RecordValue[]
  | {[key: string]: RecordValue};

/** @internal */
export type Nullable<T> = T | null;
/** @internal */
export type Optional<T> = Nullable<T> | undefined;
/** @internal */
export type AnyRecord = Record<string, RecordValue>;
/** @internal */
export type AnyAyncFunction = (...args: AnyValue[]) => Promise<AnyValue>;
/** @internal */
export type AnyFunction = (...args: AnyValue[]) => AnyValue;
/** @internal */
export type AnyOptions = Record<string, unknown>;
/** @internal */
export type UnusedOptions = Record<string, never>;
/** @internal */
export type Command = [string, string[], AnyOptions];

export type Predicator<T> = (node: T) => boolean;
/** @internal */
export type HeapNodeIdSet = Set<number>;

/** @internal */
export type HaltOrThrowOptions = {
  printErrorBeforeHalting?: boolean;
  errorHandling?: ErrorHandling;
  primaryMessageToPrint?: string;
  secondaryMessageToPrint?: string;
  printCallback?: () => void;
};

/** @internal */
export type CLIOptions = {
  cliArgs: ParsedArgs;
  configFromOptions?: AnyRecord;
};

/** @internal */
export type XvfbType = {
  start: (callback: (error: Error) => AnyValue | null) => void;
  stop: (callback: (error: Error) => AnyValue | null) => void;
  startSync: () => void;
  stopSync: () => void;
  display: () => string;
};

/** @internal */
export type CLIArgs = {
  verbose: boolean;
  app: string;
  interaction: string;
  full: boolean;
  qe: string;
  sc: boolean;
  snapshot: boolean;
  engine: string;
  browser: string;
  device: string;
  debug: boolean;
  baseline: string;
  target: string;
  final: string;
  scenario: string;
  'reset-gk': boolean;
  'gk-on': string;
  'gk-off': string;
  'skip-snapshot': boolean;
  'skip-screenshot': boolean;
  'skip-gc': boolean;
  'skip-scroll': boolean;
  'skip-extra-ops': boolean;
  'skip-extra-op': boolean;
  'run-mode': string;
  'local-puppeteer': boolean;
  'snapshot-dir': string;
};

export type Cookies = Array<{
  name: string;
  value: string;
}>;

/** @internal */
export interface IE2EScenarioSynthesizer {
  getAppName(): string;
  getOrigin(): Nullable<string>;
  getDomain(): string;
  getDomainPrefixes(): string[];
  getCookieFile(visitPlan: IE2EScenarioVisitPlan): string | null;
  getAvailableSteps(): IE2EStepBasic[];
  getNodeNameBlocklist(): string[];
  getEdgeNameBlocklist(): string[];
  getDefaultStartStepName(): string;
  injectPlan(stepName: string, scenario: IScenario): void;
  synthesisForTarget(stepName: string): IE2EScenarioVisitPlan;
  getAvailableVisitPlans(): IE2EScenarioVisitPlan[];
  getAvailableTargetNames(
    options: AnyOptions & {
      filterCb?: (node: IE2EScenarioVisitPlan) => boolean;
    },
  ): string[];
  getNumberOfWarmup(): number;
  getBaseURL(options: AnyOptions): string;
  getURLParameters(options: AnyOptions): string;
  getDevice(): string;
  getExtraOperationsForStep(_stepInfo: E2EStepInfo): E2EOperation[];
  synthesis(
    baseline: string,
    target: string,
    intermediates: string[],
    options: E2ESynthesizerOptions,
  ): IE2EScenarioVisitPlan;
}

/** @internal */
export interface E2EScenarioSynthesizerConstructor {
  new (config: Config): IE2EScenarioSynthesizer;
}

/** @internal */
export interface IRunningMode {
  setConfig(config: Config): void;
  beforeRunning(visitPlan: IE2EScenarioVisitPlan): void;
  shouldGC(tabInfo?: E2EStepInfo): boolean;
  shouldScroll(tabInfo?: E2EStepInfo): boolean;
  shouldGetMetrics(tabInfo?: E2EStepInfo): boolean;
  shouldUseConciseConsole(tabInfo?: E2EStepInfo): boolean;
  shouldTakeScreenShot(_tabInfo?: E2EStepInfo): boolean;
  shouldTakeHeapSnapshot(tabInfo?: E2EStepInfo): boolean;
  shouldExtraWaitForTarget(tabInfo?: E2EStepInfo): boolean;
  shouldExtraWaitForFinal(tabInfo?: E2EStepInfo): boolean;
  shouldRunExtraTargetOperations(tabInfo?: E2EStepInfo): boolean;
  getAdditionalMetrics(
    page: Page,
    tabInfo?: E2EStepInfo,
  ): Promise<E2EStepInfo['metrics']>;
  postProcessData(visitPlan: IE2EScenarioVisitPlan): void;
}

/** @internal */
export type Config = MemLabConfig;

/** @internal */
export type QuickExperiment = {
  universe: string;
  experiment: string;
  group: string;
};

/**
 * The type for defining custom leak-filtering logic.
 * * **Examples**:
 * ```typescript
 * const scenario = {
 *
 * };
 *
 * let map = Object.create(null);
 * const beforeLeakFilter = (snapshot: IHeapSnapshot, _leakedNodeIds: HeapNodeIdSet): void => {
 *   map = initializeMapUsingSnapshot(snapshot);
 * };
 *
 * // duplicated string with size > 1KB as memory leak
 * const leakFilter = (node: IHeapNode): boolean => {
 *   if (node.type !== 'string' || node.retainedSize < 1000) {
 *     return false;
 *   }
 *   const str = utils.getStringNodeValue(node);
 *   return map[str] > 1;
 * };
 *
 * export default {beforeLeakFilter, leakFilter};
 * ```
 */
export interface ILeakFilter {
  beforeLeakFilter?: InitLeakFilterCallback;
  leakFilter: LeakFilterCallback;
}

/**
 * Lifecycle function callback that is invoked initially once before calling any
 * leak filter function.
 *
 * @param snaphost - heap snapshot see {@link IHeapSnapshot}
 * @param leakedNodeIds - the set of leaked object (node) ids.
 */
export type InitLeakFilterCallback = (
  snapshot: IHeapSnapshot,
  leakedNodeIds: HeapNodeIdSet,
) => void;

/**
 * Callback that can be used to define a logic to filter the
 * leaked objects. The callback is only called for every node
 * allocated but not released from the target interaction
 * in the heap snapshot.
 *
 * @param node - the node that is kept alive in the memory in the heap snapshot
 * @param snapshot - the snapshot of target interaction
 * @param leakedNodeIds - the set of leaked node ids
 *
 * @returns the value indicating whether the given node in the snapshot
 * should be considered as leaked.
 * * **Examples**:
 * ```javascript
 * // any node in the heap snapshot that is greater than 1MB
 * function leakFilter(node, _snapshot, _leakedNodeIds) {
 *  return node.retainedSize > 1000000;
 * };
 * ```
 */
export type LeakFilterCallback = (
  node: IHeapNode,
  snapshot: IHeapSnapshot,
  leakedNodeIds: HeapNodeIdSet,
) => boolean;

/**
 * The callback defines browser interactions which are
 * used by memlab to interact with the web app under test.
 */
export type InteractionsCallback = (
  page: Page,
  args?: OperationArgs,
) => Promise<void>;

/**
 * Test scenario specifies how you want a E2E test to interact with a web browser.
 * The test scenario can be saved as a `.js` file and passed to the `memlab
 * run --scenario` command:
 * ```javascript
 * // save as test.js and use in terminal:
 * // $ memlab run --scenario test.js
 *
 * module.exports = {
 *   url: () => 'https://www.npmjs.com/',
 *   action: async () => ... ,
 *   back: async () => ... ,
 * };
 * ```
 *
 * The test scenario instance can also be passed to the
 * [`run` API](../modules/api_src#run) exported by `@memlab/api`.
 * ```typescript
 * const {run} = require('@memlab/api');
 *
 * (async function () {
 *   const scenario = {
 *     url: () => 'https://www.facebook.com',
 *     action: async () => ... ,
 *     back: async () => ... ,
 *   };
 *   const leaks = await run({scenario});
 * })();
 * ```
 */
export interface IScenario {
  /** @internal */
  name?: () => string;
  /** @internal */
  app?: () => string;
  /**
   * If the page you are running memlab against requires authentication or
   * specific cookie(s) to be set, you can pass them as
   * a list of <name, value> pairs.
   * @returns cookie list
   * * **Examples**:
   * ```typescript
   * const scenario = {
   *   url: () => 'https://www.facebook.com/',
   *   cookies: () => [
   *     {"name":"cm_j","value":"none"},
   *     {"name":"datr","value":"yJvIY..."},
   *     {"name":"c_user","value":"8917..."},
   *     {"name":"xs","value":"95:9WQ..."},
   *     // ...
   *   ],
   * };
   * ```
   */
  cookies?: () => Cookies;
  /**
   * String value of the initial url of the page.
   *
   * @returns the string value of the initial url
   * * **Examples**:
   * ```typescript
   * const scenario = {
   *   url: () => 'https://www.npmjs.com/',
   * };
   * ```
   * If a test scenario only specifies the `url` callback (without the `action`
   * callback), memlab will try to detect memory leaks from the initial page
   * load. All objects allocated by the initial page load will be candidates
   * for memory leak filtering.
   */
  url: () => string;
  /**
   * `action` is the callback function that defines the interaction
   * where you want to trigger memory leaks after the initial page load.
   * All JS objects in browser allocated by the browser interactions triggered
   * from the `action` callback will be candidates for memory leak filtering.
   *
   * * **Parameters**:
   *   * page: `Page` | the puppeteer [`Page`](https://pptr.dev/api/puppeteer.page)
   *     object, which provides APIs to interact with the web browser
   *
   * * **Examples**:
   * ```typescript
   * const scenario = {
   *   url: () => 'https://www.npmjs.com/',
   *   action: async (page) => {
   *     await page.click('a[href="/link"]');
   *   },
   *   back: async (page) => {
   *     await page.click('a[href="/back"]');
   *   },
   * }
   * ```
   * Note: always clean up external puppeteer references to JS objects
   *       in the browser context.
   * ```typescript
   * const scenario = {
   *   url: () => 'https://www.npmjs.com/',
   *   action: async (page) => {
   *     const elements = await page.$x("//button[contains(., 'Text in Button')]");
   *     const [button] = elements;
   *     if (button) {
   *       await button.click();
   *     }
   *     // dispose external references to JS objects in browser context
   *     await promise.all(elements.map(e => e.dispose()));
   *   },
   *   back: async (page) => ... ,
   * }
   ```
   */
  action?: InteractionsCallback;
  /**
   * `back` is the callback function that specifies how memlab should
   * back/revert the `action` callback. Think of it as an undo action.
   *
   * * **Examples**:
   * ```typescript
   * const scenario = {
   *   url: () => 'https://www.npmjs.com/',
   *   action: async (page) => {
   *     await page.click('a[href="/link"]');
   *   },
   *   back: async (page) => {
   *     await page.click('a[href="/back"]');
   *   },
   * }
   * ```
   * Check out [this page](/docs/how-memlab-works) on why
   * memlab needs to undo/revert the `action` callback.
   */
  back?: InteractionsCallback;
  /**
   * Specifies how many **extra** `action` and `back` actions performed by memlab.
   * * **Examples**:
   * ```typescript
   * module.exports = {
   *   url: () => ... ,
   *   action: async (page) => ... ,
   *   back: async (page) => ... ,
   *   // browser interaction: two additional [ action -> back ]
   *   // init-load -> action -> back -> action -> back -> action -> back
   *   repeat: () => 2,
   * };
   * ```
   */
  repeat?: () => number;
  /**
   * Optional callback function that checks if the web page is loaded
   * after for initial page loading and subsequent browser interactions.
   *
   * If this callback is not provided, memlab by default
   * considers a navigation to be finished when there are no network
   * connections for at least 500ms.
   *
   * * **Parameters**:
   *   * page: `Page` | the puppeteer [`Page`](https://pptr.dev/api/puppeteer.page)
   *     object, which provides APIs to interact with the web browser
   * * **Returns**: a boolean value, if it returns `true`, memlab will consider
   *   the navigation completes, if it returns `false`, memlab will keep calling
   *   this callback until it returns `true`. This is an async callback, you can
   *   also `await` and returns `true` until some async logic is resolved.
   * * **Examples**:
   * ```typescript
   * module.exports = {
   *   url: () => ... ,
   *   action: async (page) => ... ,
   *   back: async (page) => ... ,
   *   isPageLoaded: async (page) => {
   *     await page.waitForNavigation({
   *       // consider navigation to be finished when there are
   *       // no more than 2 network connections for at least 500 ms.
   *       waitUntil: 'networkidle2',
   *       // Maximum navigation time in milliseconds
   *       timeout: 5000,
   *     });
   *     return true;
   *   },
   * };
   * ```
   */
  isPageLoaded?: CheckPageLoadCallback;
  /**
   * Lifecycle function callback that is invoked initially once before
   * the subsequent `leakFilter` function calls. This callback could
   * be used to initialize some data stores or to do some one-off
   * preprocessings.
   *
   * * **Parameters**:
   *   * snapshot: `IHeapSnapshot` | the final heap snapshot taken after
   *     all browser interactions are done.
   *     Check out {@link IHeapSnapshot} for more APIs that queries the heap snapshot.
   *   * leakedNodeIds: `Set<number>` | the set of ids of all JS heap objects
   *     allocated by the `action` call but not released after the `back` call
   *     in browser.
   *
   * * **Examples**:
   * ```typescript
   * module.exports = {
   *   url: () => ... ,
   *   action: async (page) => ... ,
   *   back: async (page) => ... ,
   *   beforeLeakFilter: (snapshot, leakedNodeIds) {
   *     // initialize some data stores
   *   },
   * };
   * ```
   */
  beforeLeakFilter?: InitLeakFilterCallback;
  /**
   * This callback that defines how you want to filter out the
   * leaked objects. The callback is called for every node (JS heap
   * object in browser) allocated by the `action` callback, but not
   * released after the `back` callback. Those objects could be caches
   * that are retained in memory on purpose, or they are memory leaks.
   *
   * This optional callback allows you to define your own algorithm
   * to cherry pick memory leaks for specific JS program under test.
   *
   * If this optional callback is not defined, memlab will use its
   * built-in leak filter, which considers detached DOM elements
   * and unmounted Fiber nodes (detached from React Fiber tree) as
   * memory leaks.
   *
   * * **Parameters**:
   *   * node: `IHeapNode` | one of the heap object allocated but not released.
   *   * snapshot: `IHeapSnapshot` | the final heap snapshot taken after
   *     all browser interactions are done.
   *     Check out {@link IHeapSnapshot} for more APIs that queries the heap snapshot.
   *   * leakedNodeIds: `Set<number>` | the set of ids of all JS heap objects
   *     allocated by the `action` call but not released after the `back` call
   *     in browser.
   *
   * * **Returns**: the boolean value indicating whether the given node in
   *   the snapshot should be considered as leaked.
   *
   * * **Examples**:
   * ```typescript
   * module.exports = {
   *   url: () => ... ,
   *   action: async (page) => ... ,
   *   back: async (page) => ... ,
   *   leakFilter(node, snapshot, leakedNodeIds) {
   *     // any unreleased node (JS heap object) with 1MB+
   *     // retained size is considered a memory leak
   *     return node.retainedSize > 1000000;
   *   },
   * };
   * ```
   */
  leakFilter?: LeakFilterCallback;
}

/** @internal */
export type LeakTracePathItem = {
  node?: IHeapNode;
  edge?: IHeapEdge;
  next?: LeakTracePathItem;
  edgeRetainSize?: number;
};

/** @internal */
export type TraceCluster = {
  // id is assigned when saving unique trace clusters to Ent in PHP
  id?: number;
  path: LeakTracePathItem;
  count?: number;
  snapshot?: IHeapSnapshot;
  retainedSize?: number;
  leakedNodeIds?: HeapNodeIdSet;
  clusterMetaInfo?: TraceClusterMetaInfo;
};

/** @internal */
export type TraceClusterDiff = {
  staleClusters: TraceCluster[];
  clustersToAdd: TraceCluster[];
  allClusters: TraceCluster[][];
};

/** @internal */
export type LeakTraceElement = {
  kind: string; // element kind
  id?: number; // node id if exists
  name?: string;
  name_or_index?: string | number;
  type: string; // object or reference type from JS engine
};

/** @internal */
export type LeakTrace = LeakTraceElement[];

/** @internal */
export type TraceDiff = {
  staleClusters: LeakTrace[];
  clustersToAdd: LeakTrace[];
  allClusters: LeakTrace[][];
};

/** @internal */
export type TraceClusterMetaInfo = {
  cluster_id: number;
  creation_time: number;
  task?: string;
  app: string;
  num_duplicates?: number;
  retained_size?: number;
  interaction_vector?: string[];
  interaction: string;
  interaction_summary: string;
  leak_trace_summary: string;
  leak_trace_handle?: string;
  meta_data: string;
};

/** @internal */
export interface E2EInteraction {
  kind: string;
  timeout?: number;
}

/** @internal */
export type E2EOperation = E2EInteraction & {
  selector: string;
  act(page: Page, opArgs?: OperationArgs): Promise<void>;
};

/** @internal */
export type E2ESynthesizerOptions = {
  name?: string;
  type?: string;
  start?: string;
  final?: string;
  setupSteps?: string[];
  warmupSteps?: string[];
  cleanupSteps?: string[];
  repeat?: number;
  repeatSteps?: string[];
  dataBuilder?: IDataBuilder;
  newTestUser?: boolean;
  gk_enable?: string[];
  gk_disable?: string[];
};

/** @internal */
export interface IDataBuilder {
  className: string;
  state: Record<string, AnyValue>;
}

/**
 * Callback function to provide if the page is loaded.
 * @param page - puppeteer's [Page](https://pptr.dev/api/puppeteer.page/) object.
 */
export type CheckPageLoadCallback = (page: Page) => Promise<boolean>;

/** @internal */
export interface IE2EScenarioVisitPlan {
  name: string;
  appName: string;
  type: string;
  newTestUser: boolean;
  device: string;
  baseURL: string;
  URLParameters: string;
  tabsOrder: E2EStepInfo[];
  numOfWarmup: number;
  dataBuilder: Optional<IDataBuilder>;
  isPageLoaded?: CheckPageLoadCallback;
}

/** @internal */
export type OperationArgs = {
  isPageLoaded?: CheckPageLoadCallback;
  showProgress?: boolean;
  failedURLs?: AnyRecord;
  pageHistoryLength?: number[];
  delay?: number;
  mute?: boolean;
  warmup?: boolean;
  noWaitAfterPageLoad?: boolean;
};

/** @internal */
export interface IE2EStepBasic {
  name: string;
  url: string;
  urlParams?: Array<{name: string; value: string}>;
  type?: string;
  delay?: number;
  interactions: E2EOperation | Array<E2EOperation | InteractionsCallback>;
  postInteractions?: E2EOperation | Array<E2EOperation | InteractionsCallback>;
}

/** @internal */
export type E2EStepInfo = IE2EStepBasic & {
  snapshot: boolean;
  screenshot: boolean;
  idx: number;
  JSHeapUsedSize: number;
  delay?: number;
  metrics: Record<string, number>;
};

/** @internal */
export interface IBrowserInfo {
  _browserVersion: string;
  _puppeteerConfig: LaunchOptions;
  _consoleMessages: string[];
}

export type RunMetaInfo = {
  app: string;
  interaction: string;
  type: string;
  browserInfo: IBrowserInfo;
};

export interface IHeapSnapshot {
  /** @internal */
  snapshot: RawHeapSnapshot;
  /**
   * A pseudo array containing all heap graph nodes (JS objects in heap).
   * A JS heap could contain millions of heap objects, so memlab uses
   * a pseudo array as the collection of all the heap objects. The pseudo
   * array provides API to query and traverse all heap objects.
   *
   * * **Examples**:
   * ```typescript
   * import type {IHeapSnapshot, IHeapNode} from '@memlab/core';
   * import {dumpNodeHeapSnapshot} from '@memlab/core';
   * import {getHeapFromFile} from '@memlab/heap-analysis';
   *
   * (async function () {
   *   const heapFile = dumpNodeHeapSnapshot();
   *   const heap: IHeapSnapshot = await getHeapFromFile(heapFile);
   *
   *   // get the total number of heap objects
   *   heap.nodes.length;
   *
   *   heap.nodes.forEach((node: IHeapNode) => {
   *     // traverse each heap object
   *   });
   * })();
   * ```
   */
  nodes: IHeapNodes;
  /**
   * A pseudo array containing all heap graph edges (references to heap objects
   * in heap). A JS heap could contain millions of references, so memlab uses
   * a pseudo array as the collection of all the heap edges. The pseudo
   * array provides API to query and traverse all heap references.
   *
   * * **Examples**:
   * ```typescript
   * import type {IHeapSnapshot, IHeapEdge} from '@memlab/core';
   * import {dumpNodeHeapSnapshot} from '@memlab/core';
   * import {getHeapFromFile} from '@memlab/heap-analysis';
   *
   * (async function () {
   *   const heapFile = dumpNodeHeapSnapshot();
   *   const heap: IHeapSnapshot = await getHeapFromFile(heapFile);
   *
   *   // get the total number of heap references
   *   heap.edges.length;
   *
   *   heap.edges.forEach((edge: IHeapEdge) => {
   *     // traverse each reference in the heap
   *   });
   * })();
   * ```
   */
  edges: IHeapEdges;
  /**
   * If you have the id of a heap node (JS object in heap), use this API
   * to get an {@link IHeapNode} associated with the id.
   * @param id id of the heap node (JS object in heap) you would like to query
   * @returns the API returns `null` if no heap object has the specified id.
   *
   * * **Examples**:
   * ```typescript
   * import type {IHeapSnapshot} from '@memlab/core';
   * import {dumpNodeHeapSnapshot} from '@memlab/core';
   * import {getHeapFromFile} from '@memlab/heap-analysis';
   *
   * (async function () {
   *   const heapFile = dumpNodeHeapSnapshot();
   *   const heap: IHeapSnapshot = await getHeapFromFile(heapFile);
   *
   *   const node = heap.getNodeById(351);
   *   node?.id; // should be 351
   * })();
   * ```
   */
  getNodeById(id: number): Nullable<IHeapNode>;
  /**
   * Search for the heap and check if there is any JS object instance with
   * a specified constructor name.
   * @param className The contructor name of the object instance
   * @returns `true` if there is at least one such object in the heap
   *
   * * **Examples**: you can write a jest unit test with memory assertions:
   * ```typescript
   * // save as example.test.ts
   * import type {IHeapSnapshot, Nullable} from '@memlab/core';
   * import {config, getNodeInnocentHeap} from '@memlab/core';
   *
   * class TestObject {
   *   public arr1 = [1, 2, 3];
   *   public arr2 = ['1', '2', '3'];
   * }
   *
   * test('memory test with heap assertion', async () => {
   *   config.muteConsole = true; // no console output
   *
   *   let obj: Nullable<TestObject> = new TestObject();
   *   // get a heap snapshot of the current program state
   *   let heap: IHeapSnapshot = await getNodeInnocentHeap();
   *
   *   // call some function that may add references to obj
   *   rabbitHole(obj)
   *
   *   expect(heap.hasObjectWithClassName('TestObject')).toBe(true);
   *   obj = null;
   *
   *   heap = await getNodeInnocentHeap();
   *   // if rabbitHole does not have any side effect that
   *   // adds new references to obj, then obj can be GCed
   *   expect(heap.hasObjectWithClassName('TestObject')).toBe(false);
   *
   * }, 30000);
   * ```
   */
  hasObjectWithClassName(className: string): boolean;
  /**
   * Search for the heap and get one of the JS object instances with
   * a specified constructor name (if there is any).
   * @param className The contructor name of the object instance
   * @returns a handle pointing to any one of the object instances, returns
   *          `null` if no such object exists in the heap.
   *
   * * **Examples**:
   * ```typescript
   * import type {IHeapSnapshot} from '@memlab/core';
   * import {getNodeInnocentHeap} from '@memlab/core';
   *
   * class TestObject {
   *   public arr1 = [1, 2, 3];
   *   public arr2 = ['1', '2', '3'];
   * }
   *
   * (async function () {
   *   const obj = new TestObject();
   *   // get a heap snapshot of the current program state
   *   const heap: IHeapSnapshot = await getNodeInnocentHeap();
   *
   *   const node = heap.getAnyObjectWithClassName('TestObject');
   *   console.log(node?.name); // should be 'TestObject'
   * })();
   * ```
   */
  getAnyObjectWithClassName(className: string): Nullable<IHeapNode>;
  /**
   * Search for the heap and check if there is any JS object instance with
   * a specified property name.
   * @param nameOrIndex The property name (string) or element index (number)
   * on the object instance
   * @returns returns `true` if there is at least one such object in the heap
   *
   * * **Examples**:
   * ```typescript
   * import type {IHeapSnapshot} from '@memlab/core';
   * import {dumpNodeHeapSnapshot} from '@memlab/core';
   * import {getHeapFromFile} from '@memlab/heap-analysis';
   *
   * (async function () {
   *   // eslint-disable-next-line @typescript-eslint/no-unused-vars
   *   const object = {'memlab-test-heap-property': 'memlab-test-heap-value'};
   *
   *   const heapFile = dumpNodeHeapSnapshot();
   *   const heap: IHeapSnapshot = await getHeapFromFile(heapFile);
   *
   *   // should be true
   *   console.log(heap.hasObjectWithPropertyName('memlab-test-heap-property'));
   * })();
   * ```
   */
  hasObjectWithPropertyName(nameOrIndex: string | number): boolean;
  /**
   * Search for the heap and check if there is any JS object instance with
   * a marker tagged by {@link tagObject}.
   * @param tag marker name on the object instances tagged by {@link tagObject}
   * @returns returns `true` if there is at least one such object in the heap
   *
   * ```typescript
   * import type {IHeapSnapshot, AnyValue} from '@memlab/core';
   * import {config, getNodeInnocentHeap, tagObject} from '@memlab/core';
   *
   * test('memory test', async () => {
   *   config.muteConsole = true;
   *   const o1: AnyValue = {};
   *   let o2: AnyValue = {};
   *
   *   // tag o1 with marker: "memlab-mark-1", does not modify o1 in any way
   *   tagObject(o1, 'memlab-mark-1');
   *   // tag o2 with marker: "memlab-mark-2", does not modify o2 in any way
   *   tagObject(o2, 'memlab-mark-2');
   *
   *   o2 = null;
   *
   *   const heap: IHeapSnapshot = await getNodeInnocentHeap();
   *
   *   // expect object with marker "memlab-mark-1" exists
   *   expect(heap.hasObjectWithTag('memlab-mark-1')).toBe(true);
   *
   *   // expect object with marker "memlab-mark-2" can be GCed
   *   expect(heap.hasObjectWithTag('memlab-mark-2')).toBe(false);
   *
   * }, 30000);
   * ```
   */
  hasObjectWithTag(tag: string): boolean;
  /** @internal */
  clearShortestPathInfo(): void;
}

export interface IHeapLocation {
  snapshot: IHeapSnapshot;
  script_id: number;
  line: number;
  column: number;
}

export interface IHeapEdgeBasic {
  name_or_index: number | string;
  type: string;
}

export interface IHeapEdge extends IHeapEdgeBasic {
  snapshot: IHeapSnapshot;
  edgeIndex: number;
  is_index: boolean;
  to_node: number;
  toNode: IHeapNode;
  fromNode: IHeapNode;
}

/**
 * A pseudo array containing all heap graph edges (references to heap objects
 * in heap). A JS heap could contain millions of references, so memlab uses
 * a pseudo array as the collection of all the heap edges. The pseudo
 * array provides API to query and traverse all heap references.
 *
 * @readonly modifying this pseudo array is not recommended
 *
 * * **Examples**:
 * ```typescript
 * import type {IHeapSnapshot, IHeapEdges} from '@memlab/core';
 * import {dumpNodeHeapSnapshot} from '@memlab/core';
 * import {getHeapFromFile} from '@memlab/heap-analysis';
 *
 * (async function () {
 *   const heapFile = dumpNodeHeapSnapshot();
 *   const heap: IHeapSnapshot = await getHeapFromFile(heapFile);
 *
 *   const edges: IHeapEdges = heap.edges;
 *   edges.length;
 *   edges.get(0);
 *   edges.forEach((edge, i) => {
 *     if (stopIteration) {
 *       return false;
 *     }
 *   });
 * })();
 * ```
 */
export interface IHeapEdges {
  /**
   * The total number of edges in heap graph (or JS references in heap
   * snapshot).
   */
  length: number;
  /**
   * get an {@link IHeapEdge} element at the specified index
   * @param index the index of an element in the pseudo array, the index ranges
   * from 0 to array length - 1. Notice that this is not the heap node id.
   * @returns When 0 <= `index` < array.length, this API returns the element
   * at the specified index, otherwise it returns `null`.
   */
  get(index: number): Nullable<IHeapEdge>;
  /**
   * Iterate over all array elements and apply the callback
   * to each element in ascending order of element index.
   * @param callback the callback does not need to return any value, if
   * the callback returns `false` when iterating on element at index `i`,
   * then all elements after `i` won't be iterated.
   */
  forEach(callback: (edge: IHeapEdge, index: number) => void | boolean): void;
}

export interface IHeapNodeBasic {
  type: string;
  name: string;
  id: number;
}

export type EdgeIterationCallback = (
  edge: IHeapEdge,
) => Optional<{stop: boolean}>;

export interface IHeapNode extends IHeapNodeBasic {
  snapshot: IHeapSnapshot;
  is_detached: boolean;
  detachState: number;
  markAsDetached(): void;
  attributes: number;
  self_size: number;
  edge_count: number;
  trace_node_id: number;
  references: IHeapEdge[];
  referrers: IHeapEdge[];
  pathEdge: IHeapEdge | null;
  nodeIndex: number;
  retainedSize: number;
  dominatorNode: IHeapNode | null;
  location: IHeapLocation | null;
  highlight?: boolean;
  isString: boolean;
  toStringNode(): Nullable<IHeapStringNode>;
  forEachReference(callback: EdgeIterationCallback): void;
  forEachReferrer(callback: EdgeIterationCallback): void;
  findReference: (predicate: Predicator<IHeapEdge>) => Nullable<IHeapEdge>;
  findAnyReferrer: (predicate: Predicator<IHeapEdge>) => Nullable<IHeapEdge>;
  findReferrers: (predicate: Predicator<IHeapEdge>) => IHeapEdge[];
  getReference: (
    edgeName: string | number,
    edgeType?: string,
  ) => Nullable<IHeapEdge>;
  getReferenceNode: (
    edgeName: string | number,
    edgeType?: string,
  ) => Nullable<IHeapNode>;
  getAnyReferrer: (
    edgeName: string | number,
    edgeType?: string,
  ) => Nullable<IHeapEdge>;
  getAnyReferrerNode: (
    edgeName: string | number,
    edgeType?: string,
  ) => Nullable<IHeapNode>;
  getReferrers: (edgeName: string | number, edgeType?: string) => IHeapEdge[];
  getReferrerNodes: (
    edgeName: string | number,
    edgeType?: string,
  ) => IHeapNode[];
}

export interface IHeapStringNode extends IHeapNode {
  stringValue: string;
}

/**
 * A pseudo array containing all heap graph nodes (JS objects
 * in heap). A JS heap could contain millions of objects, so memlab uses
 * a pseudo array as the collection of all the heap nodes. The pseudo
 * array provides API to query and traverse all heap objects.
 *
 * @readonly modifying this pseudo array is not recommended
 *
 * * **Examples**:
 * ```typescript
 * import type {IHeapSnapshot, IHeapNodes} from '@memlab/core';
 * import {dumpNodeHeapSnapshot} from '@memlab/core';
 * import {getHeapFromFile} from '@memlab/heap-analysis';
 *
 * (async function () {
 *   const heapFile = dumpNodeHeapSnapshot();
 *   const heap: IHeapSnapshot = await getHeapFromFile(heapFile);
 *
 *   const nodes: IHeapNodes = heap.nodes;
 *   nodes.length;
 *   nodes.get(0);
 *   nodes.forEach((edge, i) => {
 *     if (stopIteration) {
 *       return false;
 *     }
 *   });
 * })();
 * ```
 */
export interface IHeapNodes {
  /**
   * The total number of nodes in heap graph (or JS objects in heap
   * snapshot).
   */
  length: number;
  /**
   * get an {@link IHeapNode} element at the specified index
   * @param index the index of an element in the pseudo array, the index ranges
   * from 0 to array length - 1. Notice that this is not the heap node id.
   * @returns When 0 <= `index` < array.length, this API returns the element
   * at the specified index, otherwise it returns `null`.
   */
  get(index: number): Nullable<IHeapNode>;
  /**
   * Iterate over all array elements and apply the callback
   * to each element in ascending order of element index.
   * @param callback the callback does not need to return any value, if
   * the callback returns `false` when iterating on element at index `i`,
   * then all elements after `i` won't be iterated.
   */
  forEach(callback: (node: IHeapNode, index: number) => void | boolean): void;
  /** @internal */
  forEachTraceable(
    callback: (node: IHeapNode, index: number) => void | boolean,
  ): void;
}

/** @internal */
export type HeapNodeFields = string[];
/** @internal */
export type HeapNodeTypes = string[];
/** @internal */
export type RawHeapNodeTypes = Array<HeapNodeTypes | string>;
/** @internal */
export type HeapEdgeFields = string[];
/** @internal */
export type HeapEdgeTypes = string[] | string;
/** @internal */
export type RawHeapEdgeTypes = Array<HeapEdgeTypes | string>;
/** @internal */
export type HeapTraceFunctionInfoFields = string[];
/** @internal */
export type HeapTraceNodeFields = string[];
/** @internal */
export type HeapSampleFields = string[];
/** @internal */
export type HeapLocationFields = string[];

/** @internal */
export type HeapSnapshotMeta = {
  node_fields: HeapNodeFields;
  node_types: RawHeapNodeTypes;
  edge_fields: HeapEdgeFields;
  edge_types: RawHeapEdgeTypes;
  trace_function_info_fields: HeapTraceFunctionInfoFields;
  trace_node_fields: HeapTraceNodeFields;
  sample_fields: HeapSampleFields;
  location_fields: HeapLocationFields;
};

/** @internal */
export type HeapSnapshotInfo = {
  meta: HeapSnapshotMeta;
  node_count: number;
  edge_count: number;
  trace_function_count: number;
};

/** @internal */
export type RawHeapSnapshot = {
  snapshot: HeapSnapshotInfo;
  nodes: number[];
  edges: number[];
  trace_function_infos: number[];
  trace_tree: number;
  samples: number[];
  locations: number[];
  strings: string[];
};

/** @internal */
export interface ISerializedInfo {
  [key: string]: string | number | boolean | ISerializedInfo;
}

/** @internal */
export type NumericDictionary = {[index: number]: number};

/** @internal */
export interface IOveralHeapInfo {
  fiberNodeSize: number;
  regularFiberNodeSize: number;
  detachedFiberNodeSize: number;
  alternateFiberNodeSize: number;
  error: number;
}

/** @internal */
export interface IOveralLeakInfo extends Partial<IOveralHeapInfo> {
  leakedSize: number;
  leakedFiberNodeSize: number;
  leakedAlternateFiberNodeSize: number;
}

/** @internal */
export interface IMemoryAnalystOptions {
  snapshotDir?: string;
  minSnapshots?: number;
}

/** @internal */
export interface IMemoryAnalystSnapshotDiff {
  leakedHeapNodeIdSet: HeapNodeIdSet;
  snapshot: IHeapSnapshot;
  listOfLeakedHeapNodeIdSet: Array<HeapNodeIdSet>;
}

/** @internal */
export interface IMemoryAnalystHeapNodeLeakSummary
  extends Pick<IHeapNode, 'name' | 'type' | 'retainedSize'> {
  count: number;
}

/** @internal */
export interface IMemoryAnalystHeapNodeReferrenceStat {
  numberOfEdgesToNode: number;
  source: IHeapNode;
  edge: IHeapEdge;
}

/** @internal */
export interface IClusterStrategy {
  diffTraces: (
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    newLeakTraces: LeakTrace[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    existingLeakTraces: LeakTrace[],
  ) => TraceDiff;
}

/** @internal */
export type ErrorWithMessage = Pick<Error, 'message'>;
