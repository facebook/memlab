/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import {ParsedArgs} from 'minimist';
import type {LaunchOptions, Page as PuppeteerPage} from 'puppeteer';
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

/**
 * Given any type `T`, returns the union type `T` and `null`.
 * @typeParam T - The type that will be made nullable.
 */
export type Nullable<T> = T | null;

/**
 * Given any type `T`, returns the union type `T`, `null`, and `undefined`.
 * @typeParam T - The type that will be made both nullable and undefinable.
 */
export type Optional<T> = T | null | undefined;

/**
 * Given any type `T`, returns the union type `T` and `undefined`.
 * @typeParam T - The type that will be made undefinable.
 */
export type Undefinable<T> = T | undefined;

/** @internal */
export type AnyRecord = Record<string, RecordValue>;
/** @internal */
export type StringRecord = Record<string, string>;
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
export type FileOption = {
  workDir?: Optional<string>;
  clear?: boolean;
  transient?: boolean;
  errorWhenAbsent?: boolean;
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
export type ShellOptions = {
  dir?: Optional<string>;
  ignoreError?: Optional<boolean>;
  throwError?: Optional<boolean>;
  disconnectStdio?: Optional<boolean>;
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

/** @internal */
interface BrowserLaunchArgumentOptions {
  headless?: boolean;
  userDataDir?: string;
  devtools?: boolean;
  debuggingPort?: number;
  args?: string[];
}

/** @internal */
interface BrowserConnectOptions {
  ignoreHTTPSErrors?: boolean;
  defaultViewport?: AnyValue | null;
  protocolTimeout?: number;
  slowMo?: number;
  targetFilter?: AnyFunction;
}

/** @internal */
export type PuppeteerConfig = LaunchOptions &
  BrowserLaunchArgumentOptions &
  BrowserConnectOptions;

/**
 * This is the puppeteer [`Page`](https://pptr.dev/api/puppeteer.page)
 * class used by MemLab. The puppeteer `Page` class instance provides
 * APIs to interact with the web browser.
 *
 * The puppeteer `Page` type can be incompatible across different versions.
 * Your local npm-installed puppeteer version may be different from
 * the puppeteer used by MemLab. This may cause some type errors, for example:
 *
 * ```typescript
 * import type {Page} from 'puppeteer';
 * import type {RunOptions} from '@memlab/api';
 *
 * const runOptions: RunOptions = {
 *   scenario: {
 *     // initial page load url: Google Maps
 *     url: () => {
 *       return "https://www.google.com/maps/@37.386427,-122.0428214,11z";
 *     },
 *     // type error here if your local puppeeter version is different
 *     // from the puppeteer used by MemLab
 *     action: async function (page: Page) {
 *       await page.click('text/Hotels');
 *     },
 *   },
 * };
 * ```
 *
 * To avoid the type error in the code example above, MemLab exports the
 * puppeteer `Page` type used by MemLab so that your code can import it
 * when necessary:
 *
 * ```typescript
 * import type {Page} from '@memlab/core' // import Page type from memlab
 * import type {RunOptions} from 'memlab';
 *
 * const runOptions: RunOptions = {
 *   scenario: {
 *     // initial page load url: Google Maps
 *     url: () => {
 *       return "https://www.google.com/maps/@37.386427,-122.0428214,11z";
 *     },
 *     // no type error here
 *     action: async function (page: Page) {
 *       await page.click('text/Hotels');
 *     },
 *   },
 * };
 * ```
 */
export type Page = PuppeteerPage;

/**
 * the predicate callback is used to decide if an
 * entity of type `T` meets certain criteria.
 * For more concrete examples on where it is used,
 * check out {@link findAnyReference}, {@link findAnyReferrer},
 * and {@link findReferrers}.
 *
 * @typeParam T - the type of the entity to be checked
 * @param entity - the entity to be checked
 * @returns whether the entity passes the predicate check
 */
export type Predicator<T> = (entity: T) => boolean;

/**
 * Data structure for holding cookies.
 * For concrete use case, please check out {@link cookies}.
 */
export type Cookies = Array<Cookie>;

/**
 * A single cookie entry in a Cookies list.
 * The `name` and `value` field is mandatory.
 * It is better to also specify the `domain` field, otherwise MemLab
 * will try to infer `domain` automatically.
 * The other fields are optional.
 * For concrete use case, please check out {@link cookies}.
 */
export type Cookie = {
  /** Mandatory: Represents the name of the cookie */
  name: string;
  /** Mandatory: Represents the value assigned to the cookie */
  value: string;
  /** Optional: Defines the domain associated with the cookie */
  domain?: string;
  /**
   * Optional: Specifies the request-URI linked with the cookie setup.
   * This can influence the cookie's default domain and path.
   */
  url?: Undefinable<string>;
  /** Optional: Defines the path associated with the cookie */
  path?: Undefinable<string>;
  /** Optional: Indicates when the cookie will expire, in Unix time (seconds) */
  expires?: Undefinable<number>;
  /** Optional: Flag to determine if the cookie is accessible only over HTTP */
  httpOnly?: Undefinable<boolean>;
  /** Optional: Flag to check if the cookie is a session cookie */
  session?: Undefinable<boolean>;
  /**
   * Optional: Flag to indicate if the cookie transmission
   * requires a secure protocol (e.g., HTTPS).
   */
  secure?: Undefinable<boolean>;
  /**
   * Optional: Determines if a cookie is transmitted with cross-site requests,
   * offering a degree of defense against cross-site request forgery attacks.
   */
  sameSite?: Undefinable<'Strict' | 'Lax'>;
};

/** @internal */
export interface IE2EScenarioSynthesizer {
  getAppName(): string;
  getOrigin(): Nullable<string>;
  getDomain(): string;
  getDomainPrefixes(): string[];
  getCookieFile(visitPlan: IE2EScenarioVisitPlan): Nullable<string>;
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
export interface IPackageInfo {
  name: string;
  version: string;
  packageLocation?: string;
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
 * The `ILeakFilter` interface allows you to define a leak detector and
 * customize the leak filtering logic in memlab (instead of using the
 * built-in leak filters).
 *
 * Use the leak filter definition in command line interface to filter
 * leaks detected from browser interactions
 * ```bash
 * memlab run --scenario <SCENARIO FILE> --leak-filter <PATH TO leak-filter.js>
 * ```
 *
 * If you have already run `memlab run` or `memlab snapshot` which saved
 * heap snapshot and other meta data on disk, use the following command
 * to filter leaks based on those saved heap snapshots (query the default
 * data location by `memlab get-default-work-dir`).
 *
 * ```bash
 * memlab find-leaks --leak-filter <PATH TO leak-filter.js>
 * ```
 * Here is an example TypeScript file defining a leak filter.
 * The command line interface only accepts compiled JavaScript file.
 * You can also define the leak filter in JavaScript (without the
 * type annotations.
 *
 * ```typescript
 * import {IHeapNode, IHeapSnapshot, HeapNodeIdSet, utils} from '@memlab/core';
 *
 * function initMap(snapshot: IHeapSnapshot): Record<string, number> {
 *   const map = Object.create(null);
 *   snapshot.nodes.forEach(node => {
 *     if (node.type !== 'string') {
 *       return;
 *     }
 *     const str = utils.getStringNodeValue(node);
 *     if (str in map) {
 *       ++map[str];
 *     } else {
 *       map[str] = 1;
 *     }
 *   });
 *   return map;
 * }
 * const beforeLeakFilter = (snapshot: IHeapSnapshot, _leakedNodeIds: HeapNodeIdSet): void => {
 *   map = initMap(snapshot);
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
  /**
   * Lifecycle function callback that is invoked initially once before
   * the subsequent `leakFilter` function calls. This callback could
   * be used to initialize some data stores or any one-off
   * preprocessings.
   *
   * * * **Parameters**:
   *   * `snapshot`: <code>{@link IHeapSnapshot}</code> | the final heap
   *      snapshot taken after all browser interactions are done.
   *      Check out {@link IHeapSnapshot} for more APIs that queries the
   *      heap snapshot.
   *   * `leakedNodeIds`: `Set<number>` | the set of ids of all JS heap objects
   *      allocated by the `action` call but not released after the `back` call
   *      in browser.
   *
   * * **Examples**:
   * ```javascript
   * module.exports = {
   *   beforeLeakFilter: (snapshot, leakedNodeIds) {
   *     // initialize some data stores
   *   },
   *   leakFilter(node, snapshot, leakedNodeIds) {
   *     // use the data stores
   *   },
   * };
   * ```
   */
  beforeLeakFilter?: InitLeakFilterCallback;
  /**
   * This callback defines how you want to filter out the
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
   *   * `node`: <code>{@link IHeapNode}</code> | the heap object
   *      allocated but not released. This filter callback will be applied
   *      to each node allocated but not released in the heap snapshot.
   *   * `snapshot`: <code>{@link IHeapSnapshot}</code> | the final heap
   *      snapshot taken after all browser interactions are done.
   *      Check out {@link IHeapSnapshot} for more APIs that queries the
   *      heap snapshot.
   *   * `leakedNodeIds`: `Set<number>` | the set of ids of all JS heap objects
   *      allocated by the `action` call but not released after the `back` call
   *      in browser.
   *
   * * **Returns**: the boolean value indicating whether the given node in
   *   the snapshot should be considered as leaked.
   *
   * * **Examples**:
   * ```javascript
   * // save as leak-filter.js
   * module.exports = {
   *   leakFilter(node, snapshot, leakedNodeIds) {
   *     // any unreleased node (JS heap object) with 1MB+
   *     // retained size is considered a memory leak
   *     return node.retainedSize > 1000000;
   *   },
   * };
   * ```
   *
   * Use the leak filter definition in command line interface:
   * ```bash
   * memlab find-leaks --leak-filter <PATH TO leak-filter.js>
   * ```
   *
   * ```bash
   * memlab run --scenario <SCENARIO FILE> --leak-filter <PATH TO leak-filter.js>
   * ```
   */
  leakFilter?: LeakFilterCallback;
  /**
   * Callback that can be used to define a logic to decide whether
   * a reference should be considered as part of the retainer trace.
   * The callback is called for every reference (edge) in the heap snapshot.
   *
   * For concrete examples, check out {@link leakFilter}.
   *
   * * **Parameters**:
   *   * `edge` : <code>{@link IHeapEdge}</code> | the reference (edge)
   *      that is considered for calcualting the retainer trace
   *   * `snapshot`: <code>{@link IHeapSnapshot}</code> | the final heap
   *      snapshot taken after all browser interactions are done.
   *      Check out {@link IHeapSnapshot} for more APIs that queries the
   *      heap snapshot.
   *   * `isReferenceUsedByDefault`: `boolean` | MemLab has its own default
   *      logic for whether a reference should be considered as part of the
   *      retainer trace, if this parameter is true, it means MemLab will
   *      consider this reference when calculating the retainer trace.
   *
   * * **Returns**: the value indicating whether the given reference should be
   * considered when calculating the retainer trace. Note that when this
   * callback returns true, the reference will only be considered as a candidate
   * for retainer trace, so it may or may not be included in the retainer trace;
   * however, if this callback returns false, the reference will be excluded.
   *
   * Note that by excluding a dominator reference of an object (i.e., an edge
   * that must be traveled through to reach the heap object from GC roots),
   * the object will be considered as unreachable in the heap graph; and
   * therefore, the reference and heap object will not be included in the
   * retainer trace detection and retainer size calculation.
   *
   * Please also be aware that some edges like self-referencing edges,
   * JS engine's internal edges, and hidden edges should not be considered
   * as part of the retainer trace. These edges could make the retainer trace
   * unncessarily complex and cause confusion. `isReferenceUsedByDefault` will
   * be `false` for these types of edges.
   *
   * * **Examples**:
   * ```javascript
   * // save as leak-filter.js
   * module.exports = {
   *   retainerReferenceFilter(edge, _snapshot, _isReferenceUsedByDefault) {
   *     // exclude react fiber references
   *     if (edge.name_or_index.toString().startsWith('__reactFiber$')) {
   *       return false;
   *     }
   *     // exclude other references here
   *     // ...
   *     return true;
   *   }
   * };
   * ```
   *
   * Use the leak filter definition in command line interface:
   * ```bash
   * memlab find-leaks --leak-filter <PATH TO leak-filter.js>
   * ```
   *
   * ```bash
   * memlab run --scenario <SCENARIO FILE> --leak-filter <PATH TO leak-filter.js>
   * ```
   */
  retainerReferenceFilter?: ReferenceFilterCallback;
}

/**
 * Lifecycle function callback that is invoked initially once before calling any
 * leak filter function.
 * For concrete example, check out {@link beforeLeakFilter}.
 *
 * @param snapshot heap snapshot see {@link IHeapSnapshot}
 * @param leakedNodeIds the set of leaked object (node) ids.
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
 * For concrete examples, check out {@link leakFilter}.
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
 * Callback that can be used to define a logic to decide whether
 * a reference should be filtered (included) for some
 * calculations (e.g., retainer trace calculation)
 *
 * For concrete examples, check out {@link leakFilter}.
 *
 * @param edge - the reference (edge) that is considered
 * for calcualting the retainer trace
 * @param snapshot - the final snapshot taken after all browser
 * interactions are done.
 * @param isReferenceUsedByDefault - MemLab has its own default logic for
 * whether a reference should be filtered (included), if this parameter is true,
 * it means MemLab will consider this reference for inclusion
 *
 * @returns the value indicating whether the given reference should be
 * filtered (i.e., included)
 *
 * Please also be aware that some edges like self-referencing edges,
 * JS engine's internal edges, and hidden edges should not be considered
 * as part of the retainer trace. These edges could make the retainer trace
 * unncessarily complex and cause confusion. `isReferenceUsedByDefault` will
 * be `false` for these types of edges.
 *
 * * **Examples**:
 * ```javascript
 * // exclude react fiber references
 * function retainerReferenceFilter(edge, _snapshot, _isReferenceUsedByDefault) {
 *   if (edge.name_or_index.toString().startsWith('__reactFiber$')) {
 *     return false;
 *   }
 *   // exclude other references here
 *   // ...
 *   return true;
 * };
 * ```
 */
export type ReferenceFilterCallback = (
  edge: IHeapEdge,
  snapshot: IHeapSnapshot,
  isReferenceUsedByDefault: boolean,
) => boolean;

/**
 * The callback defines browser interactions which are
 * used by memlab to interact with the web app under test.
 * For concrete examples, check out {@link action} or {@link back}.
 *
 * @param page the puppeteer [`Page`](https://pptr.dev/api/puppeteer.page)
 * object, which provides APIs to interact with the web browser.
 * To import this type, check out {@link Page}.
 * @returns no return value
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
 *   cookies: () => ... , // optional
 *   repeat: () => ... , // optional
 *   ...
 * };
 * ```
 *
 * The test scenario instance can also be passed to the
 * {@link run} API exported by `@memlab/api`.
 * ```typescript
 * const {run} = require('@memlab/api');
 *
 * (async function () {
 *   const scenario = {
 *     url: () => 'https://www.facebook.com',
 *     action: async () => ... ,
 *     back: async () => ... ,
 *     cookies: () => ... , // optional
 *     repeat: () => ... , // optional
 *     ...
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
   * a list of `<name, value, domain>` tuples.
   *
   * **Note**: please make sure that you provide the correct `domain` field for
   * the cookies tuples. If no `domain` field is specified, memlab will try
   * to fill in a domain based on the `url` callback.
   * For example, when the `domain` field is absent,
   * memlab will auto fill in `.facebook.com` as domain base
   * on the initial page load's url: `https://www.facebook.com/`.
   *
   * @returns cookie list
   * * **Examples**:
   * ```typescript
   * const scenario = {
   *   url: () => 'https://www.facebook.com/',
   *   cookies: () => [
   *     {name:'cm_j', value: 'none', domain: '.facebook.com'},
   *     {name:'datr', value: 'yJvIY...', domain: '.facebook.com'},
   *     {name:'c_user', value: '8917...', domain: '.facebook.com'},
   *     {name:'xs', value: '95:9WQ...', domain: '.facebook.com'},
   *     // ...
   *   ],
   * };
   *
   * module.exports = scenario;
   * ```
   */
  cookies?: () => Cookies;
  /**
   * `beforeInitialPageLoad` is the callback function that will be called only
   * once before the initial page load. This callback can be used to set up
   * the HTTP headers or to prepare data before loading the web page.
   *
   * * **Parameters**:
   *   * `page`: <code>{@link Page}</code> | the puppeteer
   *     [`Page`](https://pptr.dev/api/puppeteer.page)
   *     object, which provides APIs to interact with the web browser. To import
   *     this type, check out {@link Page}.
   *
   * * **Examples**:
   * ```typescript
   * const scenario = {
   *   url: () => 'https://www.npmjs.com/',
   *   beforeInitialPageLoad: async (page) => {
   *     // before the initial page load
   *   },
   *   action: async (page) => {
   *     await page.click('a[href="/link"]');
   *   },
   *   back: async (page) => {
   *     await page.click('a[href="/back"]');
   *   },
   * }
   *
   * module.exports = scenario;
   * ```
   */
  beforeInitialPageLoad?: InteractionsCallback;
  /**
   * String value of the initial url of the page.
   *
   * @returns the string value of the initial url
   * * **Examples**:
   * ```typescript
   * const scenario = {
   *   url: () => 'https://www.npmjs.com/',
   * };
   *
   * module.exports = scenario;
   * ```
   * If a test scenario only specifies the `url` callback (without the `action`
   * callback), memlab will try to detect memory leaks from the initial page
   * load. All objects allocated by the initial page load will be candidates
   * for memory leak filtering.
   */
  url: () => string;
  /**
   * `setup` is the callback function that will be called only once
   * after the initial page load. This callback can be used to log in
   * if you have to (we recommend using {@link cookies})
   * or to prepare data before the {@link action} call.
   *
   * * **Parameters**:
   *   * `page`: <code>{@link Page}</code> | the puppeteer
   *     [`Page`](https://pptr.dev/api/puppeteer.page)
   *     object, which provides APIs to interact with the web browser. To import
   *     this type, check out {@link Page}.
   *
   * * **Examples**:
   * ```typescript
   * const scenario = {
   *   url: () => 'https://www.npmjs.com/',
   *   setup: async (page) => {
   *     // log in or prepare data for the interaction
   *   },
   *   action: async (page) => {
   *     await page.click('a[href="/link"]');
   *   },
   *   back: async (page) => {
   *     await page.click('a[href="/back"]');
   *   },
   * }
   *
   * module.exports = scenario;
   * ```
   */
  setup?: InteractionsCallback;
  /**
   * `action` is the callback function that defines the interaction
   * where you want to trigger memory leaks after the initial page load.
   * All JS objects in browser allocated by the browser interactions triggered
   * from the `action` callback will be candidates for memory leak filtering.
   *
   * * **Parameters**:
   *   * `page`: <code>{@link Page}</code> | the puppeteer
   *     [`Page`](https://pptr.dev/api/puppeteer.page)
   *     object, which provides APIs to interact with the web browser. To import
   *     this type, check out {@link Page}.
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
   *
   * module.exports = scenario;
   * ```
   * Note: Always dispose of puppeteer element handles (e.g., from page.$x or
   * page.$) to prevent memory leaks in the browser context. Use
   * element.dispose() or Promise.all(elements.map(e => e.dispose())) to
   * clean up.
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
   *
   * module.exports = scenario;
   * ```
   */
  action?: InteractionsCallback;
  /**
   * `back` is the callback function that specifies how memlab should
   * back/revert the `action` callback. Think of it as an undo action.
   *
   * * **Parameters**:
   *   * `page`: <code>{@link Page}</code> | the puppeteer
   *     [`Page`](https://pptr.dev/api/puppeteer.page)
   *     object, which provides APIs to interact with the web browser. To import
   *     this type, check out {@link Page}.
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
   * Specifies how many **extra** `action` and `back` actions performed
   * by memlab.
   *
   * * **Returns**: a number value specifies the number of extra actions.
   *
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
   * for the initial page load and subsequent browser interactions.
   *
   * If this callback is not provided, memlab by default
   * considers a navigation to be finished when there are no network
   * connections for at least 500ms.
   *
   * * **Parameters**:
   *   * `page`: <code>{@link Page}</code> | the puppeteer
   *     [`Page`](https://pptr.dev/api/puppeteer.page)
   *     object, which provides APIs to interact with the web browser. To import
   *     this type, check out {@link Page}.
   *
   * * **Returns**: a boolean value, if it returns `true`, memlab will consider
   *   the navigation completes, if it returns `false`, memlab will keep calling
   *   this callback until it returns `true`. This is an async callback, you can
   *   also `await` and returns `true` until some async logic is resolved.
   *
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
   * be used to initialize some data stores or to any one-off
   * preprocessings.
   *
   * * **Parameters**:
   *   * `snapshot`: <code>{@link IHeapSnapshot}</code> | the final heap
   *      snapshot taken after all browser interactions are done.
   *      Check out {@link IHeapSnapshot} for more APIs that queries the
   *      heap snapshot.
   *   * `leakedNodeIds`: `Set<number>` | the set of ids of all JS heap objects
   *      allocated by the `action` call but not released after the `back` call
   *      in browser.
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
   * This callback defines how you want to filter out the
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
   *   * `node`: <code>{@link IHeapNode}</code> | the heap object
   *      allocated but not released. This filter callback will be applied
   *      to each node allocated but not released in the heap snapshot.
   *   * `snapshot`: <code>{@link IHeapSnapshot}</code> | the final heap
   *      snapshot taken after all browser interactions are done.
   *      Check out {@link IHeapSnapshot} for more APIs that queries the
   *      heap snapshot.
   *   * `leakedNodeIds`: `Set<number>` | the set of ids of all JS heap objects
   *      allocated by the `action` call but not released after the `back` call
   *      in browser.
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
  /**
   * Callback that can be used to define a logic to decide whether
   * a reference should be considered as part of the retainer trace.
   * The callback is called for every reference (edge) in the heap snapshot.
   *
   * For concrete examples, check out {@link leakFilter}.
   *
   * * **Parameters**:
   *   * `edge` : <code>{@link IHeapEdge}</code> | the reference (edge)
   *      that is considered for calcualting the retainer trace
   *   * `snapshot`: <code>{@link IHeapSnapshot}</code> | the heap snapshot
   *      taken after all browser interactions are done.
   *      Check out {@link IHeapSnapshot} for more APIs that queries the
   *      heap snapshot.
   *   * `isReferenceUsedByDefault`: `boolean` | MemLab has its own default
   *      logic for whether a reference should be considered as part of the
   *      retainer trace, if this parameter is true, it means MemLab will
   *      consider this reference when calculating the retainer trace.
   *
   * * **Returns**: the value indicating whether the given reference should be
   * considered when calculating the retainer trace. Note that when this
   * callback returns true, the reference will only be considered as a candidate
   * for retainer trace, so it may or may not be included in the retainer trace;
   * however, if this callback returns false, the reference will be excluded.
   *
   * Note that by excluding a dominator reference of an object (i.e., an edge
   * that must be traveled through to reach the heap object from GC roots),
   * the object will be considered as unreachable in the heap graph; and
   * therefore, the reference and heap object will not be included in the
   * retainer trace detection and retainer size calculation.
   *
   * * **Examples**:
   * ```javascript
   * // save as leak-filter.js
   * module.exports = {
   *   retainerReferenceFilter(edge, _snapshot, _leakedNodeIds) {
   *     // exclude react fiber references
   *     if (edge.name_or_index.toString().startsWith('__reactFiber$')) {
   *       return false;
   *     }
   *     return true;
   *   }
   * };
   * ```
   */
  retainerReferenceFilter?: ReferenceFilterCallback;
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
export type ControlTreatmentClusterResult = {
  // all traces in the cluster are from some or all of the control groups
  controlLikelyOrOnlyClusters: TraceCluster[];
  // all traces in the cluster are from all of the treatment groups
  treatmentOnlyClusters: TraceCluster[];
  // all traces in the cluster are from some (not all) of the treatment groups
  treatmentLikelyClusters: TraceCluster[];
  // traces in this cluster consists of traces from both control and treatment groups
  hybridClusters: Array<{control: TraceCluster; treatment: TraceCluster}>;
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
 * For concrete example, check out {@link isPageLoaded}.
 * @param page - puppeteer's [Page](https://pptr.dev/api/puppeteer.page/) object.
 * To import this type, check out {@link Page}.
 * @returns a boolean value, if it returns `true`, memlab will consider
 * the navigation completes, if it returns `false`, memlab will keep calling
 * this callback until it returns `true`. This is an async callback, you can
 * also `await` and returns `true` until some async logic is resolved.
 */
export type CheckPageLoadCallback = (page: Page) => Promise<boolean>;

/** @internal */
export type PageSetupCallback = (page: Page) => Promise<void>;

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
  scenario?: IScenario;
  pageSetup?: PageSetupCallback;
}

/** @internal */
export type OperationArgs = {
  isPageLoaded?: CheckPageLoadCallback;
  scenario?: Optional<IScenario>;
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
  snapshotFile?: string;
  screenshot: boolean;
  idx: number;
  JSHeapUsedSize: number;
  delay?: number;
  metrics: Record<string, number>;
};

/**
 * This data structure contains the input configuration for the browser and
 * output data from the browser. You can retrieve the instance of this type
 * through {@link RunMetaInfo}.
 */
export interface IBrowserInfo {
  /**
   * browser version
   */
  _browserVersion: string;
  /**
   * configuration for puppeteer
   */
  _puppeteerConfig: LaunchOptions;
  /**
   * all web console output
   */
  _consoleMessages: string[];
}

/**
 * This data structure holds the information about memlab run.
 * You can retrieve the instance of this type through {@link getRunMetaInfo}.
 */
export type RunMetaInfo = {
  /** @internal */
  app: string;
  /** @internal */
  interaction: string;
  /**
   * type of the memlab run
   */
  type: string;
  /**
   * input configuration for the browser and
   * output data from the browser
   */
  browserInfo: IBrowserInfo;
  /** @internal */
  extraInfo?: StringRecord;
};

/**
 * A heap snapshot is generally a graph where graph nodes are JS heap objects
 * and graph edges are JS references among JS heap objects. For more details
 * on the structure of nodes and edges in the heap graph, check out
 * {@link IHeapNode} and {@link IHeapEdge}.
 */
export interface IHeapSnapshot {
  /**
   * flag indicating if the heap snapshot has included
   * the post-processing meta data (e.g., shortest path to GC root,
   * dominator info and retainer size etc.)
   * @internal
   */
  isProcessed: boolean;
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
   * import {getFullHeapFromFile} from '@memlab/heap-analysis';
   *
   * (async function () {
   *   const heapFile = dumpNodeHeapSnapshot();
   *   const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);
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
   * import {getFullHeapFromFile} from '@memlab/heap-analysis';
   *
   * (async function () {
   *   const heapFile = dumpNodeHeapSnapshot();
   *   const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);
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
   * import {getFullHeapFromFile} from '@memlab/heap-analysis';
   *
   * (async function () {
   *   const heapFile = dumpNodeHeapSnapshot();
   *   const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);
   *
   *   const node = heap.getNodeById(351);
   *   node?.id; // should be 351
   * })();
   * ```
   */
  getNodeById(id: number): Nullable<IHeapNode>;
  /**
   * Given an array of ids of heap nodes (JS objects in heap), use this API
   * to get an array of those heap nodes.
   * @param ids id array of the heap nodes (JS objects in heap) you
   * would like to query
   * @returns an array of those heap nodes. The return array will preserve the
   * order of the input array. If an id is not found in the heap, the
   * corresponding element in the return array will be `null`.
   *
   * * **Examples**:
   * ```typescript
   * import type {IHeapSnapshot} from '@memlab/core';
   * import {dumpNodeHeapSnapshot} from '@memlab/core';
   * import {getFullHeapFromFile} from '@memlab/heap-analysis';
   *
   * (async function () {
   *   const heapFile = dumpNodeHeapSnapshot();
   *   const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);
   *
   *   // suppose 1000 is not a valid id in the heap
   *   const nodes = heap.getNodesByIds([1, 2, 1000, 3]);
   *   nodes // should be [node1, node2, null, node3]
   * })();
   * ```
   */
  getNodesByIds(ids: number[]): Array<Nullable<IHeapNode>>;
  /**
   * Given a set of ids of heap nodes (JS objects in heap), use this API
   * to get a set of those heap nodes.
   * @param ids id set of the heap nodes (JS objects in heap) you
   * would like to query
   * @returns a set of those heap nodes. The set will only include
   * nodes that are found in the heap. If none of the input ids are found,
   * this API will return an empty set.
   *
   * * **Examples**:
   * ```typescript
   * import type {IHeapSnapshot} from '@memlab/core';
   * import {dumpNodeHeapSnapshot} from '@memlab/core';
   * import {getFullHeapFromFile} from '@memlab/heap-analysis';
   *
   * (async function () {
   *   const heapFile = dumpNodeHeapSnapshot();
   *   const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);
   *
   *   // suppose 1000 is not a valid id in the heap
   *   const set = heap.getNodesByIdSet(new Set([1, 2, 1000, 3]));
   *   set // should be Set([node1, node2, node3])
   * })();
   * ```
   */
  getNodesByIdSet(ids: Set<number>): Set<IHeapNode>;
  /**
   * Search for the heap and check if there is any JS object instance with
   * a specified constructor name.
   * @param className The constructor name of the object instance
   * @returns `true` if there is at least one such object in the heap
   *
   * * **Examples**: you can write a jest unit test with memory assertions:
   * ```typescript
   * // save as example.test.ts
   * import type {IHeapSnapshot, Nullable} from '@memlab/core';
   * import {config, takeNodeMinimalHeap} from '@memlab/core';
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
   *   let heap: IHeapSnapshot = await takeNodeMinimalHeap();
   *
   *   // call some function that may add references to obj
   *   rabbitHole(obj)
   *
   *   expect(heap.hasObjectWithClassName('TestObject')).toBe(true);
   *   obj = null;
   *
   *   heap = await takeNodeMinimalHeap();
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
   * @param className The constructor name of the object instance
   * @returns a handle pointing to any one of the object instances, returns
   *          `null` if no such object exists in the heap.
   *
   * * **Examples**:
   * ```typescript
   * import type {IHeapSnapshot} from '@memlab/core';
   * import {takeNodeMinimalHeap} from '@memlab/core';
   *
   * class TestObject {
   *   public arr1 = [1, 2, 3];
   *   public arr2 = ['1', '2', '3'];
   * }
   *
   * (async function () {
   *   const obj = new TestObject();
   *   // get a heap snapshot of the current program state
   *   const heap: IHeapSnapshot = await takeNodeMinimalHeap();
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
   * import {getFullHeapFromFile} from '@memlab/heap-analysis';
   *
   * (async function () {
   *   // eslint-disable-next-line @typescript-eslint/no-unused-vars
   *   const object = {'memlab-test-heap-property': 'memlab-test-heap-value'};
   *
   *   const heapFile = dumpNodeHeapSnapshot();
   *   const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);
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
   *
   * The `tagObject` API does not modify the object instance in any way
   * (e.g., no additional or hidden properties added to the tagged object).
   *
   * @param tag marker name on the object instances tagged by {@link tagObject}
   * @returns returns `true` if there is at least one such object in the heap
   *
   * ```typescript
   * import type {IHeapSnapshot, AnyValue} from '@memlab/core';
   * import {config, takeNodeMinimalHeap, tagObject} from '@memlab/core';
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
   *   const heap: IHeapSnapshot = await takeNodeMinimalHeap();
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

/**
 * An `IHeapLocation` instance contains a source location information
 * associated with a JS heap object.
 * A heap snapshot is generally a graph where graph nodes are JS heap objects
 * and graph edges are JS references among JS heap objects.
 *
 * @readonly it is not recommended to modify any `IHeapLocation` instance
 *
 * * **Examples**: V8 or hermes heap snapshot can be parsed by the
 * {@link getFullHeapFromFile} API.
 *
 * ```typescript
 * import type {IHeapSnapshot, IHeapNode, IHeapLocation} from '@memlab/core';
 * import {dumpNodeHeapSnapshot} from '@memlab/core';
 * import {getFullHeapFromFile} from '@memlab/heap-analysis';
 *
 * (async function () {
 *   const heapFile = dumpNodeHeapSnapshot();
 *   const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);
 *
 *   // iterate over each node (heap object)
 *   heap.nodes.forEach((node: IHeapNode, i: number) => {
 *     const location: Nullable<IHeapLocation> = node.location;
 *     if (location) {
 *       // use the location API here
 *       location.line;
 *       // ...
 *     }
 *   });
 * })();
 * ```
 */
export interface IHeapLocation {
  /**
   * get the {@link IHeapSnapshot} containing this location instance
   */
  snapshot: IHeapSnapshot;
  /**
   * get the heap object this location this location represents
   */
  node: Nullable<IHeapNode>;
  /**
   * get the script ID of the source file
   */
  script_id: number;
  /**
   * get the line number
   */
  line: number;
  /**
   * get the column number
   */
  column: number;
  /**
   * convert to a concise readable object that can be used for serialization
   * (like calling `JSON.stringify(node, ...args)`).
   *
   * This API does not contain all the information
   * captured by the hosting object.
   */
  getJSONifyableObject(): AnyRecord;
  /**
   * convert to a concise readable string output
   * (like calling `JSON.stringify(node, ...args)`).
   *
   * Note: Please be aware that using `JSON.stringify(node, ...args)` is
   * not recommended as it will generate a JSON representation of the host
   * object that is too large to be easily readable due to its connections
   * to other parts of the data structures within the heap snapshot.
   *
   * This API does not completely serialize all the information
   * captured by the hosting object.
   */
  toJSONString(...args: Array<AnyValue>): string;
}

/** @internal */
export interface IHeapEdgeBasic {
  /**
   * name of the JS reference. If this is a reference to an array element
   * or internal table element, it is an numeric index
   */
  name_or_index: number | string;
  /**
   * type of the JS reference, all types:
   * `context`, `element`, `property`, `internal`, `hidden`, `shortcut`, `weak`
   */
  type: string;
}

/**
 * An `IHeapEdge` instance represents a JS reference in a heap snapshot.
 * A heap snapshot is generally a graph where graph nodes are JS heap objects
 * and graph edges are JS references among JS heap objects.
 *
 * @readonly it is not recommended to modify any `IHeapEdge` instance
 *
 * * **Examples**: V8 or hermes heap snapshot can be parsed by the
 * {@link getFullHeapFromFile} API.
 *
 * ```typescript
 * import type {IHeapSnapshot, IHeapEdge} from '@memlab/core';
 * import {dumpNodeHeapSnapshot} from '@memlab/core';
 * import {getFullHeapFromFile} from '@memlab/heap-analysis';
 *
 * (async function () {
 *   const heapFile = dumpNodeHeapSnapshot();
 *   const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);
 *
 *   // iterate over each edge (JS reference in heap)
 *   heap.edges.forEach((edge: IHeapEdge, i: number) => {
 *     // use the heap edge APIs here
 *     const nameOrIndex = edge.name_or_index;
 *     // ...
 *   });
 * })();
 * ```
 */
export interface IHeapEdge extends IHeapEdgeBasic {
  /**
   * get the {@link IHeapSnapshot} containing this JS reference
   */
  snapshot: IHeapSnapshot;
  /**
   * index of this JS reference inside the `edge.snapshot.edges` pseudo array
   */
  edgeIndex: number;
  /**
   * if `true`, means this is a reference to an array element
   * or internal table element (`edge.name_or_index` will return a number),
   * otherwise this is a reference with a string name (`edge.name_or_index`
   * will return a string)
   */
  is_index: boolean;
  /**
   * the index of the JS heap object pointed to by this reference
   */
  to_node: number;
  /**
   * returns an {@link IHeapNode} instance representing the JS heap object
   * pointed to by this reference
   */
  toNode: IHeapNode;
  /**
   * returns an {@link IHeapNode} instance representing the hosting
   * JS heap object where this reference starts
   */
  fromNode: IHeapNode;
  /**
   * convert to a concise readable object that can be used for serialization
   * (like calling `JSON.stringify(node, ...args)`).
   *
   * This API does not contain all the information
   * captured by the hosting object.
   */
  getJSONifyableObject(): AnyRecord;
  /**
   * convert to a concise readable string output
   * (like calling `JSON.stringify(node, ...args)`).
   *
   * Note: Please be aware that using `JSON.stringify(node, ...args)` is
   * not recommended as it will generate a JSON representation of the host
   * object that is too large to be easily readable due to its connections
   * to other parts of the data structures within the heap snapshot.
   *
   * This API does not completely serialize all the information
   * captured by the hosting object.
   */
  toJSONString(...args: Array<AnyValue>): string;
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
 * import {getFullHeapFromFile} from '@memlab/heap-analysis';
 *
 * (async function () {
 *   const heapFile = dumpNodeHeapSnapshot();
 *   const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);
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

/** @internal */
export interface IHeapNodeBasic {
  /**
   * The type of the heap node object. All possible types:
   * This is engine-specific, for example all types in V8:
   * `hidden`, `array`, `string`, `object`, `code`, `closure`, `regexp`,
   * `number`, `native`, `synthetic`, `concatenated string`, `sliced string`,
   * `symbol`, `bigint`
   */
  type: string;
  /**
   * This is the `name` field associated with the heap object.
   * For JS object instances (type `object`), `name` is the constructor's name
   * of the object instance. For `string`, `name` is the string value.
   */
  name: string;
  /**
   * Unique id of the heap object.
   */
  id: number;
}

/**
 * Executes a provided callback once for JavaScript references.
 * For concrete examples, check out {@link forEachReference}
 * or {@link forEachReferrer}.
 * @param callback the callback for each JavaScript reference from a collection
 * @returns this API returns void
 */
export type EdgeIterationCallback = (
  edge: IHeapEdge,
) => Optional<{stop: boolean}> | void;
/**
 * An `IHeapNode` instance represents a JS heap object in a heap snapshot.
 * A heap snapshot is generally a graph where graph nodes are JS heap objects
 * and graph edges are JS references among JS heap objects.
 *
 * @readonly it is not recommended to modify any `IHeapNode` instance
 *
 * * **Examples**: V8 or hermes heap snapshot can be parsed by the
 * {@link getFullHeapFromFile} API.
 *
 * ```typescript
 * import type {IHeapSnapshot, IHeapNode} from '@memlab/core';
 * import {dumpNodeHeapSnapshot} from '@memlab/core';
 * import {getFullHeapFromFile} from '@memlab/heap-analysis';
 *
 * (async function () {
 *   const heapFile = dumpNodeHeapSnapshot();
 *   const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);
 *
 *   // iterate over each node (heap object)
 *   heap.nodes.forEach((node: IHeapNode, i: number) => {
 *     // use the heap node APIs here
 *     const id = node.id;
 *     const type = node.type;
 *     // ...
 *   });
 * })();
 * ```
 */
export interface IHeapNode extends IHeapNodeBasic {
  /**
   * Gets the {@link IHeapSnapshot} containing this heap object.
   */
  snapshot: IHeapSnapshot;
  /**
   * * If the heap object is a DOM element and the DOM element is detached
   * from the DOM tree, `is_detached` will be `true`;
   * * If the heap object is a React Fiber node and the Fiber node is unmounted
   * from the React Fiber tree, `is_detached` will be `true`;
   * otherwise it will be `false`.
   */
  is_detached: boolean;
  /** @internal */
  detachState: number;
  /** @internal */
  markAsDetached(): void;
  /** @internal */
  attributes: number;
  /**
   * The *shallow size* of the heap object (i.e., the size of memory that is held
   * by the object itself). For difference between **shallow size** and
   * **retained size**, check out
   * [this doc](https://developer.chrome.com/docs/devtools/memory-problems/memory-101/#object_sizes).
   */
  self_size: number;
  /**
   * The total number of outgoing JS references (including engine-internal,
   * native, and JS references).
   */
  edge_count: number;
  /** @internal */
  trace_node_id: number;
  /**
   * Gets a JS array containing all outgoing JS references from this heap object
   * (including engine-internal, native, and JS references).
   */
  references: IHeapEdge[];
  /**
   * Gets a JS array containing all incoming JS references pointing to this heap
   * object (including engine-internal, native, and JS references).
   */
  referrers: IHeapEdge[];
  /**
   * Gets the number of all incoming references pointing to this heap object
   * (including engine-internal, native, and JS references).
   */
  numOfReferrers: number;
  /**
   * Returns true if the heap node has been set an incoming edge
   * which leads to the parent node on the shortest path to GC root.
   */
  hasPathEdge: boolean;
  /**
   * The incoming edge which leads to the parent node
   * on the shortest path to GC root.
   */
  pathEdge: IHeapEdge | null;
  /**
   * Index of this heap object inside the `node.snapshot.nodes` pseudo array.
   */
  nodeIndex: number;
  /**
   * The *retained size* of the heap object (i.e., the total size of memory that
   * could be released if this object is released). For difference between
   * **retained size** and **shallow size**, check out
   * [this doc](https://developer.chrome.com/docs/devtools/memory-problems/memory-101/#object_sizes).
   */
  retainedSize: number;
  /**
   * Gets the dominator node of this node. If the dominator node gets released
   * there will be no path from GC to this node, and therefore this node can
   * also be released.
   * For more information on what a dominator node is, please check out
   * [this doc](https://developer.chrome.com/docs/devtools/memory-problems/memory-101/#dominators).
   */
  dominatorNode: Nullable<IHeapNode>;
  /**
   * Source location information of this heap object (if it is recorded by
   * the heap snapshot).
   */
  location: Nullable<IHeapLocation>;
  /** @internal */
  highlight?: boolean;
  /**
   * Checks if this is a string node (normal string node, concatenated string node
   * or sliced string node).
   */
  isString: boolean;
  /**
   * Converts to an {@link IHeapStringNode} object if this node is a string node.
   * The {@link IHeapStringNode} object supports querying the string content
   * inside the string node.
   */
  toStringNode(): Nullable<IHeapStringNode>;
  /**
   * Converts to a concise readable object that can be used for serialization
   * (like calling `JSON.stringify(node, ...args)`).
   *
   * This API does not contain all the information
   * captured by the hosting object.
   */
  getJSONifyableObject(): AnyRecord;
  /**
   * Converts to a concise readable string output
   * (like calling `JSON.stringify(node, ...args)`).
   *
   * Note: Please be aware that using `JSON.stringify(node, ...args)` is
   * not recommended as it will generate a JSON representation of the host
   * object that is too large to be easily readable due to its connections
   * to other parts of the data structures within the heap snapshot.
   *
   * This API does not completely serialize all the information
   * captured by the hosting object.
   */
  toJSONString(...args: Array<AnyValue>): string;
  /**
   * Executes a provided callback once for each JavaScript reference in the
   * hosting node (or outgoing edges from the node).
   * @param callback the callback for each outgoing JavaScript reference
   * @returns this API returns void
   *
   * * **Examples**:
   * ```typescript
   * node.forEachReference((edge: IHeapEdge) => {
   *   // process edge ...
   *
   *   // if no need to iterate over remaining edges after
   *   // the current edge in the node.references list
   *   return {stop: true};
   * });
   * ```
   */
  forEachReference(callback: EdgeIterationCallback): void;
  /**
   * Executes a provided callback once for each JavaScript reference pointing
   * to the hosting node (or incoming edges to the node).
   * @param callback the callback for each incoming JavaScript reference
   * @returns this API returns void
   *
   * * **Examples**:
   * ```typescript
   * node.forEachReferrer((edge: IHeapEdge) => {
   *   // process edge ...
   *
   *   // if no need to iterate over remaining edges after
   *   // the current edge in the node.referrers list
   *   return {stop: true};
   * });
   * ```
   */
  forEachReferrer(callback: EdgeIterationCallback): void;
  /**
   * Executes a provided predicate callback once for each JavaScript reference
   * in the hosting node (or outgoing edges from the node) until the predicate
   * returns `true`.
   * @param predicate the callback for each outgoing JavaScript reference
   * @returns the first outgoing edge for which the predicate returns `true`,
   * otherwise returns `null` if no such edge is found.
   *
   * * **Examples**:
   * ```typescript
   * const reference = node.findAnyReference((edge: IHeapEdge) => {
   *   // find the outgoing reference with name "ref"
   *   return edge.name_or_index === 'ref';
   * });
   * ```
   */
  findAnyReference: (predicate: Predicator<IHeapEdge>) => Nullable<IHeapEdge>;
  /**
   * Executes a provided predicate callback once for each JavaScript reference
   * pointing to the hosting node (or incoming edges to the node) until the
   * predicate returns `true`.
   * @param predicate the callback for each incoming JavaScript reference
   * @returns the first incoming edge for which the predicate returns `true`,
   * otherwise returns `null` if no such edge is found.
   *
   * * **Examples**:
   * ```typescript
   * const referrer = node.findAnyReferrer((edge: IHeapEdge) => {
   *   // find the incoming reference with name "ref"
   *   return edge.name_or_index === 'ref';
   * });
   * ```
   */
  findAnyReferrer: (predicate: Predicator<IHeapEdge>) => Nullable<IHeapEdge>;
  /**
   * Executes a provided predicate callback once for each JavaScript heap
   * object (heap graph node) pointing to the hosting node
   * (or nodes having edges to the hosting node) until the predicate
   * returns `true`.
   * @param predicate the callback for each incoming JavaScript heap object
   * @returns the first referring node for which the predicate returns `true`,
   * otherwise returns `null` if no such node is found.
   *
   * * **Examples**:
   * ```typescript
   * const referrer = node.findAnyReferrerNode((node: IHeapNode) => {
   *   // find the referring node with name "Parent"
   *   return node.name === 'Parent';
   * });
   * ```
   */
  findAnyReferrerNode(predicate: Predicator<IHeapNode>): Nullable<IHeapNode>;
  /**
   * Executes a provided predicate callback once for each JavaScript reference
   * pointing to the hosting node (or incoming edges to the node).
   * @param predicate the callback for each incoming JavaScript reference
   * @returns an array containing all the incoming edges for which the
   * predicate returns `true`, otherwise returns an empty array if no such
   * edge is found.
   *
   * * **Examples**:
   * ```typescript
   * const referrers = node.findReferrers((edge: IHeapEdge) => {
   *   // find all the incoming references with name "ref"
   *   return edge.name_or_index === 'ref';
   * });
   * ```
   */
  findReferrers: (predicate: Predicator<IHeapEdge>) => IHeapEdge[];
  /**
   * Executes a provided predicate callback once for each JavaScript heap
   * object (heap graph node) pointing to the hosting node
   * (or nodes having edges to the hosting node).
   * @param predicate the callback for each referrer nodes
   * @returns an array containing all the referrer nodes for which the
   * predicate returns `true`, otherwise returns an empty array if no such
   * node is found.
   *
   * * **Examples**:
   * ```typescript
   * const referrerNodes = node.findReferrerNodes((node: IHeapNode) => {
   *   // find all the referring nodes with name "Parent"
   *   return node.name === 'Parent';
   * });
   * ```
   */
  findReferrerNodes: (predicate: Predicator<IHeapNode>) => IHeapNode[];
  /**
   * Given a JS reference's name and type, this API finds an outgoing JS
   * reference from the hosting node.
   * @param edgeName the name of the outgoing JavaScript reference
   * @param edgeType optional parameter specifying the type of the outgoing
   * JavaScript reference
   * @returns the outgoing edge that meets the specification
   *
   * * **Examples**:
   * ```typescript
   * // find the internal reference to node's hidden class
   * const reference = node.getReference('map', 'hidden');
   * ```
   */
  getReference: (
    edgeName: string | number,
    edgeType?: string,
  ) => Nullable<IHeapEdge>;
  /**
   * Given a JS reference's name and type, this API finds the outgoing JS
   * reference from the hosting node, and returns the JS heap object pointed to
   * by the outgoing JS reference.
   * @param edgeName the name of the outgoing JavaScript reference
   * @param edgeType optional parameter specifying the type of the outgoing
   * JavaScript reference
   * @returns the node pointed to by the outgoing reference that meets
   * the specification
   *
   * * **Examples**:
   * ```typescript
   * // find the node's hidden class
   * const hiddenClassNode = node.getReferenceNode('map', 'hidden');
   * // this is equivalent to
   * const hiddenClassNode2 = node.getReference('map', 'hidden')?.toNode;
   * ```
   */
  getReferenceNode: (
    edgeName: string | number,
    edgeType?: string,
  ) => Nullable<IHeapNode>;
  /**
   * Given a JS reference's name and type, this API finds an incoming JS
   * reference pointing to the hosting node.
   * @param edgeName the name of the incoming JavaScript reference
   * @param edgeType optional parameter specifying the type of the incoming
   * JavaScript reference
   * @returns the incoming edge that meets the specification
   *
   * * **Examples**:
   * ```typescript
   * // find one of the JS reference named "ref" pointing to node
   * const reference = node.getAnyReferrer('ref', 'property');
   * ```
   */
  getAnyReferrer: (
    edgeName: string | number,
    edgeType?: string,
  ) => Nullable<IHeapEdge>;
  /**
   * Given a JS reference's name and type, this API finds one of the incoming JS
   * references pointing to the hosting node, and returns the JS heap object
   * containing the incoming reference.
   * @param edgeName the name of the incoming JavaScript reference
   * @param edgeType optional parameter specifying the type of the incoming
   * JavaScript reference
   * @returns the node containing the incoming JS reference that meets
   * the specification
   *
   * * **Examples**:
   * ```typescript
   * // find one of the JS heap object with a JS reference
   * // named "ref" pointing to node
   * const n1 = node.getAnyReferrerNode('ref', 'property');
   * // this is equivalent to
   * const n2 = node.getAnyReferrer('ref', 'property')?.fromNode;
   * ```
   */
  getAnyReferrerNode: (
    edgeName: string | number,
    edgeType?: string,
  ) => Nullable<IHeapNode>;
  /**
   * Given a JS reference's name and type, this API finds all the incoming JS
   * references pointing to the hosting node.
   * @param edgeName the name of the incoming JavaScript reference
   * @param edgeType optional parameter specifying the type of the incoming
   * JavaScript reference
   * @returns an array containing all the incoming edges that
   * meet the specification
   *
   * * **Examples**:
   * ```typescript
   * // find all of the JS references named "ref" pointing to node
   * const referrers = node.getReferrers('ref', 'property');
   * ```
   */
  getReferrers: (edgeName: string | number, edgeType?: string) => IHeapEdge[];
  /**
   * Given a JS reference's name and type, this API finds all of the incoming JS
   * references pointing to the hosting node, and returns an array containing
   * the hosting node for each of the incoming JS references.
   * @param edgeName the name of the incoming JavaScript reference
   * @param edgeType optional parameter specifying the type of the incoming
   * JavaScript reference
   * @returns an array containing the hosting nodes, with each node corresponds
   * to each incoming JS reference that meets the specification
   *
   * * **Examples**:
   * ```typescript
   * // find all of the JS heap objects with a JS reference
   * // named "ref" pointing to node
   * const nodes1 = node.getReferrerNodes('ref', 'property');
   * // this is equivalent to
   * const nodes2 = node.getReferrers('ref', 'property')
   *   .map(edge => edge.fromNode);
   * ```
   */
  getReferrerNodes: (
    edgeName: string | number,
    edgeType?: string,
  ) => IHeapNode[];
}

/**
 * An `IHeapStringNode` instance represents a JS string in a heap snapshot.
 * A heap snapshot is generally a graph where graph nodes are JS heap objects
 * and graph edges are JS references among JS heap objects.
 *
 * @readonly it is not recommended to modify any `IHeapStringNode` instance
 *
 * * **Examples**: V8 or hermes heap snapshot can be parsed by the
 * {@link getFullHeapFromFile} API.
 *
 * ```typescript
 * import type {IHeapSnapshot, IHeapNode, IHeapStringNode} from '@memlab/core';
 * import {dumpNodeHeapSnapshot} from '@memlab/core';
 * import {getFullHeapFromFile} from '@memlab/heap-analysis';
 *
 * (async function () {
 *   const heapFile = dumpNodeHeapSnapshot();
 *   const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);
 *
 *   // iterate over each node (heap object)
 *   heap.nodes.forEach((node: IHeapNode, i: number) => {
 *     if (node.isString) {
 *       const stringNode: IHeapStringNode = node.toStringNode();
 *       // get the string value
 *       stringNode.stringValue;
 *     }
 *   });
 * })();
 * ```
 */
export interface IHeapStringNode extends IHeapNode {
  /**
   * Gets the string value of the JS string heap object associated with
   * this `IHeapStringNode` instance in heap.
   */
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
 * import {getFullHeapFromFile} from '@memlab/heap-analysis';
 *
 * (async function () {
 *   const heapFile = dumpNodeHeapSnapshot();
 *   const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);
 *
 *   const nodes: IHeapNodes = heap.nodes;
 *   nodes.length;
 *   nodes.get(0);
 *   nodes.forEach((node, i) => {
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
   * Gets an {@link IHeapNode} element at the specified index.
   * @param index the index of an element in the pseudo array, the index ranges
   * from 0 to array length - 1. Notice that this is not the heap node id.
   * @returns When 0 <= `index` < array.length, this API returns the element
   * at the specified index, otherwise it returns `null`.
   */
  get(index: number): Nullable<IHeapNode>;
  /**
   * Iterates over all array elements and applies the callback
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
export type DiffLeakOptions = {
  controlWorkDirs: string[];
  treatmentWorkDirs: string[];
};

/** @internal */
export type PlotMemoryOptions = {
  controlWorkDirs?: string[];
  treatmentWorkDirs?: string[];
  workDir?: string;
} & IMemoryAnalystOptions;

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
    newLeakTraces: LeakTrace[],
    existingLeakTraces: LeakTrace[],
  ) => TraceDiff;
}

/** @internal */
export interface IHeapConfig {
  isCliInteractiveMode: boolean;
  currentHeapFile: Optional<string>;
  currentHeap: Optional<IHeapSnapshot>;
}

/** @internal */
export type ErrorWithMessage = Pick<Error, 'message'>;

/** @internal */
export type CommandOptionExample =
  | string
  | {
      description?: string;
      cliOptionExample: string;
    };

/** @internal */
export type JSONifyArgs = {
  leakedIdSet?: Set<number>;
  nodeIdsInSnapshots?: Array<Set<number>>;
};

/** @internal */
export interface ISerializationHelper {
  setSnapshot(snapshot: IHeapSnapshot): void;
  createOrMergeWrapper(
    info: ISerializedInfo,
    node: IHeapNode,
    args: JSONifyArgs,
    options: JSONifyOptions,
  ): ISerializedInfo;
}

/** @internal */
export type JSONifyOptions = {
  fiberNodeReturnTrace: Record<number, string>;
  processedNodeId: Set<number>;
  forceJSONifyDepth?: number;
  serializationHelper?: ISerializationHelper;
};

/** @internal */
export type ConsoleOutputAnnotation = 'stack-trace';

/** @internal */
export type ConsoleOutputOptions = {
  annotation?: ConsoleOutputAnnotation;
};

/** @internal */
export type TagType = 'opening' | 'closing' | 'self-closing';

/** @internal */
export interface ParsedAttribute {
  key: string;
  value: string | boolean;
}

/** @internal */
export interface ParsedTag {
  tagName: string;
  attributes: ParsedAttribute[];
  type: TagType;
}
