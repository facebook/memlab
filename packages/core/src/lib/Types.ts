/**
 * Copyright 2004-present Facebook. All Rights Reserved.
 *
 * @emails oncall+ws_labs
 */

import {ParsedArgs} from 'minimist';
import type {LaunchOptions, Page} from 'puppeteer';
import type {ErrorHandling, MemLabConfig} from './Config';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyValue = any;
export type RecordValue =
  | string
  | number
  | boolean
  | null
  | RecordValue[]
  | {[key: string]: RecordValue};

export type Nullable<T> = T | null;
export type Optional<T> = Nullable<T> | undefined;

export type AnyRecord = Record<string, RecordValue>;
export type AnyAyncFunction = (...args: AnyValue[]) => Promise<AnyValue>;
export type AnyFunction = (...args: AnyValue[]) => AnyValue;
export type AnyOptions = Record<string, unknown>;
export type UnusedOptions = Record<string, never>;
export type Command = [string, string[], AnyOptions];

export type Predicator<T> = (node: T) => boolean;
export type HeapNodeIdSet = Set<IHeapNode['id']>;

export type HaltOrThrowOptions = {
  printErrorBeforeHalting?: boolean;
  errorHandling?: ErrorHandling;
  primaryMessageToPrint?: string;
  secondaryMessageToPrint?: string;
  printCallback?: () => void;
};

export type CLIOptions = {
  cliArgs: ParsedArgs;
  configFromOptions?: AnyRecord;
};

export type XvfbType = {
  start: (callback: (error: Error) => AnyValue | null) => void;
  stop: (callback: (error: Error) => AnyValue | null) => void;
  startSync: () => void;
  stopSync: () => void;
  display: () => string;
};

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

type CookieItem = {
  name: string;
  value: string;
};
export type Cookies = Array<CookieItem>;

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

export interface E2EScenarioSynthesizerConstructor {
  new (config: Config): IE2EScenarioSynthesizer;
}

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

export type Config = MemLabConfig;

export type QuickExperiment = {
  universe: string;
  experiment: string;
  group: string;
};

export type InteractionsCallback = (
  page: Page,
  args?: OperationArgs,
) => Promise<void>;

export interface IScenario {
  name?: () => string;
  app?: () => string;
  cookies?: () => CookieItem[];
  url: () => string;
  action?: InteractionsCallback;
  back?: InteractionsCallback;
  repeat?: () => number;
  isPageLoaded?: CheckPageLoadCallback;
}

export type LeakTracePathItem = {
  node?: IHeapNode;
  edge?: IHeapEdge;
  next?: LeakTracePathItem;
  edgeRetainSize?: number;
};

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

export type TraceClusterDiff = {
  staleClusters: TraceCluster[];
  clustersToAdd: TraceCluster[];
  allClusters: TraceCluster[][];
};

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

export interface E2EInteraction {
  kind: string;
  timeout?: number;
}

export type E2EOperation = E2EInteraction & {
  selector: string;
  act(page: Page, opArgs?: OperationArgs): Promise<void>;
};

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

export interface IDataBuilder {
  className: string;
  state: Record<string, AnyValue>;
}

export type CheckPageLoadCallback = (page: Page) => Promise<boolean>;

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

export interface IE2EStepBasic {
  name: string;
  url: string;
  urlParams?: Array<{name: string; value: string}>;
  type?: string;
  delay?: number;
  interactions: E2EOperation | Array<E2EOperation | InteractionsCallback>;
  postInteractions?: E2EOperation | Array<E2EOperation | InteractionsCallback>;
}

export type E2EStepInfo = IE2EStepBasic & {
  snapshot: boolean;
  screenshot: boolean;
  idx: number;
  JSHeapUsedSize: number;
  delay?: number;
  metrics: Record<string, number>;
};

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
  snapshot: RawHeapSnapshot;
  nodes: IHeapNodes;
  edges: IHeapEdges;
  getNodeById(id: number): Nullable<IHeapNode>;
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

export interface IHeapEdges {
  length: number;
  get(index: number): IHeapEdge;
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
  forEachReference(callback: EdgeIterationCallback): void;
  referrers: IHeapEdge[];
  forEachReferrer(callback: EdgeIterationCallback): void;
  findReference: (predicate: Predicator<IHeapEdge>) => Nullable<IHeapEdge>;
  findReferrer: (predicate: Predicator<IHeapEdge>) => Nullable<IHeapEdge>;
  pathEdge: IHeapEdge | null;
  nodeIndex: number;
  retainedSize: number;
  dominatorNode: IHeapNode | null;
  location: IHeapLocation | null;
  highlight?: boolean;
}

export interface IHeapNodes {
  length: number;
  get(index: number): IHeapNode;
  forEach(callback: (node: IHeapNode, index: number) => void | boolean): void;
  forEachTraceable(
    callback: (node: IHeapNode, index: number) => void | boolean,
  ): void;
}

export type HeapNodeFields = string[];
export type HeapNodeTypes = string[];
export type RawHeapNodeTypes = Array<HeapNodeTypes | string>;
export type HeapEdgeFields = string[];
export type HeapEdgeTypes = string[] | string;
export type RawHeapEdgeTypes = Array<HeapEdgeTypes | string>;
export type HeapTraceFunctionInfoFields = string[];
export type HeapTraceNodeFields = string[];
export type HeapSampleFields = string[];
export type HeapLocationFields = string[];

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

export type HeapSnapshotInfo = {
  meta: HeapSnapshotMeta;
  node_count: number;
  edge_count: number;
  trace_function_count: number;
};

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

export interface ISerializedInfo {
  [key: string]: string | number | boolean | ISerializedInfo;
}

export type NumericDictionary = {[index: number]: number};

export interface IOveralHeapInfo {
  fiberNodeSize: number;
  regularFiberNodeSize: number;
  detachedFiberNodeSize: number;
  alternateFiberNodeSize: number;
  error: number;
}

export interface IOveralLeakInfo extends Partial<IOveralHeapInfo> {
  leakedSize: number;
  leakedFiberNodeSize: number;
  leakedAlternateFiberNodeSize: number;
}

export interface IMemoryAnalystOptions {
  snapshotDir?: string;
  minSnapshots?: number;
}

export interface IMemoryAnalystSnapshotDiff {
  leakedHeapNodeIdSet: HeapNodeIdSet;
  snapshot: IHeapSnapshot;
  listOfLeakedHeapNodeIdSet: Array<HeapNodeIdSet>;
}

export interface IMemoryAnalystHeapNodeLeakSummary
  extends Pick<IHeapNode, 'name' | 'type' | 'retainedSize'> {
  count: number;
}

export interface IMemoryAnalystHeapNodeReferrenceStat {
  numberOfEdgesToNode: number;
  source: IHeapNode;
  edge: IHeapEdge;
}

export type MemLabTraceElementType = {
  kind: string; // element kind
  name?: string;
  name_or_index?: string | number;
  type: string; // object or reference type from JS engine
};

export type MemLabTraceElementTypeWithID = MemLabTraceElementType & {
  id: number;
};

export type ErrorWithMessage = Pick<Error, 'message'>;
