/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {HaltOrThrowOptions, HeapNodeIdSet, ShellOptions} from './Types';

import fs from 'fs';
import path from 'path';
import cp from 'child_process';
import process from 'process';
import config, {ErrorHandling} from './Config';
import info from './Console';
import constant from './Constant';
import parser from './HeapParser';
import browserInfo from './BrowserInfo';

const memCache: Record<string, AnyValue> = Object.create(null);

import type {Browser, Page} from 'puppeteer';
import type {
  AnyAyncFunction,
  AnyOptions,
  E2EStepInfo,
  IHeapSnapshot,
  IHeapNode,
  IHeapEdge,
  IScenario,
  ILeakFilter,
  LeakTracePathItem,
  RunMetaInfo,
  RawHeapSnapshot,
  AnyValue,
  ErrorWithMessage,
  Nullable,
  Optional,
} from './Types';
import fileManager from './FileManager';
import {utils} from '..';
import {isHeapStringType} from './heap-data/HeapNode';

// For more details see ReactWorkTags.js of React
const reactWorkTag = {
  FunctionComponent: 0,
  ClassComponent: 1,
  IndeterminateComponent: 2,
  HostRoot: 3,
  HostPortal: 4,
  HostComponent: 5,
  HostText: 6,
  Fragment: 7,
  Mode: 8,
  ContextConsumer: 9,
  ContextProvider: 10,
  ForwardRef: 11,
  Profiler: 12,
  SuspenseComponent: 13,
  MemoComponent: 14,
  SimpleMemoComponent: 15,
  LazyComponent: 16,
  IncompleteClassComponent: 17,
  DehydratedFragment: 18,
  SuspenseListComponent: 19,
  ScopeComponent: 21,
  OffscreenComponent: 22,
  LegacyHiddenComponent: 23,
  CacheComponent: 24,
};
const reactTagIdToName: string[] = [];
Object.entries(reactWorkTag).forEach(
  workTag => (reactTagIdToName[workTag[1]] = workTag[0]),
);

function _getReactWorkTagName(
  tagId: Nullable<string | number>,
): Nullable<string> {
  if (typeof tagId === 'string') {
    tagId = parseInt(tagId, 10);
  }
  if (typeof tagId !== 'number' || tagId !== tagId) {
    return null;
  }
  return reactTagIdToName[tagId];
}

function isHermesInternalObject(node: IHeapNode): boolean {
  return (
    node.type === 'number' ||
    node.name === 'HiddenClass' ||
    node.name === 'Environment' ||
    node.name === 'ArrayStorage' ||
    node.name === 'SegmentedArray' ||
    node.name === 'WeakValueMap' ||
    node.name === 'HashMapEntry'
  );
}

function isStackTraceFrame(node: IHeapNode): boolean {
  if (!node || node.type !== 'hidden') {
    return false;
  }
  return node.name === 'system / StackTraceFrame';
}

// returns true if it is detached DOM element or detached FiberNode
// NOTE: Doesn't work for FiberNode without detachedness field
function isDetached(node: IHeapNode): boolean {
  if (config.snapshotHasDetachedness) {
    return node.is_detached;
  }
  return node.name.startsWith('Detached ');
}

function isFiberNode(node: Optional<IHeapNode>): boolean {
  if (!node || node.type !== 'object') {
    return false;
  }
  const name = node.name;
  return name === 'FiberNode' || name === 'Detached FiberNode';
}

// quickly check the detachedness field
// need to call hasHostRoot(node) before this function
// does not traverse and check the existance of HostRoot
// NOTE: Doesn't work for FiberNode without detachedness field
function isDetachedFiberNode(node: IHeapNode): boolean {
  return isFiberNode(node) && isDetached(node);
}

// this function returns a more general sense of DOM nodes. Specifically,
// any detached DOM nodes (e.g., HTMLXXElement, IntersectionObserver etc.)
// that are not internal nodes.
function isDetachedDOMNode(
  node: Optional<IHeapNode>,
  args: AnyOptions = {},
): boolean {
  let name = null;
  if (!node || typeof (name = node.name) !== 'string') {
    return false;
  }
  if (isFiberNode(node)) {
    return false;
  }
  if (name === 'Detached InternalNode' && args.ignoreInternalNode) {
    return false;
  }
  return isDetached(node);
}

function isWeakMapEdge(edge: IHeapEdge): boolean {
  if (!edge || typeof edge.name_or_index !== 'string') {
    return false;
  }
  if (edge.name_or_index.indexOf('WeakMap') < 0) {
    return false;
  }
  return true;
}

function isWeakMapEdgeToKey(edge: IHeapEdge): boolean {
  if (!isWeakMapEdge(edge)) {
    return false;
  }
  const weakMapKeyObjectId = getWeakMapEdgeKeyId(edge);
  const toNodeObjectId = edge.toNode.id;
  // in WeakMap, keys are weakly referenced
  if (weakMapKeyObjectId === toNodeObjectId) {
    return true;
  }
  return false;
}

function isWeakMapEdgeToValue(edge: IHeapEdge): boolean {
  if (!isWeakMapEdge(edge)) {
    return false;
  }
  const weakMapKeyObjectId = getWeakMapEdgeKeyId(edge);
  const toNodeObjectId = edge.toNode.id;
  // in WeakMap, keys are weakly referenced
  if (weakMapKeyObjectId !== toNodeObjectId) {
    return true;
  }
  return false;
}

function isEssentialEdge(
  nodeIndex: number,
  edgeType: string,
  rootNodeIndex: number,
): boolean {
  // According to Chrome Devtools, most shortcut edges are non-essential
  // except at the root node, which have special meaning of marking user
  // global objects
  // NOTE: However, bound function may have a shortcut edge to the bound
  //       host object
  return (
    edgeType !== 'weak' &&
    (edgeType !== 'shortcut' || nodeIndex === rootNodeIndex)
  );
}

function isFiberNodeDeletionsEdge(edge: IHeapEdge): boolean {
  if (!edge || !edge.fromNode || !edge.toNode) {
    return false;
  }
  if (!isFiberNode(edge.fromNode)) {
    return false;
  }
  return edge.name_or_index === 'deletions';
}

function isBlinkRootNode(node: IHeapNode): boolean {
  if (!node || !node.name) {
    return false;
  }
  return (
    node.type === 'synthetic' &&
    (node.name === 'Blink cross-thread roots' || node.name === 'Blink roots')
  );
}

function isPendingActivityNode(node: IHeapNode): boolean {
  if (!node || !node.name) {
    return false;
  }
  return node.type === 'synthetic' && node.name === 'Pending activities';
}

// check the node against a curated list of known HTML Elements
// the list may be incomplete
function isDOMNodeIncomplete(node: IHeapNode): boolean {
  let name = node.name;
  const pattern = /^HTML.*Element$/;
  const detachedPrefix = 'Detached ';
  if (name.startsWith(detachedPrefix)) {
    name = name.substring(detachedPrefix.length);
  }
  return pattern.test(name);
}

function isRootNode(node: IHeapNode, opt: AnyOptions = {}): boolean {
  if (!node) {
    return false;
  }
  // consider Hermes snapshot GC roots
  if (config.jsEngine === 'hermes') {
    return node.name === '(GC roots)' || node.name === '(GC Roots)';
  }
  if (node.id === 0 || node.id === 1) {
    return true;
  }
  // the window object
  if (node.type === 'native' && node.name.indexOf('Window') === 0) {
    return true;
  }
  if (node.type === 'synthetic' && node.name === '(GC roots)') {
    return true;
  }
  if (!opt.excludeBlinkRoot && isBlinkRootNode(node)) {
    return true;
  }
  if (!opt.excludePendingActivity && isPendingActivityNode(node)) {
    return true;
  }
  return false;
}

// in Hermes engine, directProp edge is a shortcut reference
// and is less useful for debugging leak trace
const directPropRegex = /^directProp\d+$/;
function isDirectPropEdge(edge: IHeapEdge): boolean {
  return directPropRegex.test(`${edge.name_or_index}`);
}

function isReturnEdge(edge: IHeapEdge): boolean {
  if (!edge) {
    return false;
  }
  if (typeof edge.name_or_index !== 'string') {
    return false;
  }
  return edge.name_or_index.startsWith('return');
}

function isReactPropsEdge(edge: IHeapEdge): boolean {
  if (!edge) {
    return false;
  }
  if (typeof edge.name_or_index !== 'string') {
    return false;
  }
  return edge.name_or_index.startsWith('__reactProps$');
}

function isReactFiberEdge(edge: IHeapEdge): boolean {
  if (!edge) {
    return false;
  }
  if (typeof edge.name_or_index !== 'string') {
    return false;
  }
  return edge.name_or_index.startsWith('__reactFiber$');
}

function hasReactEdges(node: IHeapNode): boolean {
  if (!node) {
    return false;
  }
  let ret = false;
  node.forEachReference((edge: IHeapEdge) => {
    if (isReactFiberEdge(edge) || isReactPropsEdge(edge)) {
      ret = true;
    }
    return {stop: true};
  });
  return ret;
}

// HostRoot's stateNode should be a FiberRootNode
function isHostRoot(node: IHeapNode): boolean {
  if (!isFiberNode(node)) {
    return false;
  }
  const stateNode = getToNodeByEdge(node, 'stateNode', 'property');
  return !!stateNode && stateNode.name === 'FiberRootNode';
}

function getReactFiberNode(node: Nullable<IHeapNode>, propName: string) {
  if (!node || !isFiberNode(node)) {
    return;
  }
  const targetNode = getToNodeByEdge(node, propName, 'property');
  return isFiberNode(targetNode) ? targetNode : undefined;
}

// check if the current node's parent has the node as a child
function checkIsChildOfParent(node: IHeapNode): boolean {
  const parent = getToNodeByEdge(node, 'return', 'property');
  let matched = false;
  iterateChildFiberNodes(parent, child => {
    if (child.id === node.id) {
      matched = true;
      return {stop: true};
    }
  });
  return matched;
}

type IterateCallback = (node: IHeapNode) => {stop: boolean} | void;
// iterate through immediate children
function iterateChildFiberNodes(
  node: Nullable<IHeapNode>,
  cb: IterateCallback,
): void {
  if (!isFiberNode(node)) {
    return;
  }
  const visited = new Set();
  let cur = getReactFiberNode(node, 'child');
  while (cur && isFiberNode(cur) && !visited.has(cur.id)) {
    const ret = cb(cur);
    visited.add(cur.id);
    if (ret && ret.stop) {
      break;
    }
    cur = getReactFiberNode(cur, 'sibling');
  }
}

function iterateDescendantFiberNodes(
  node: IHeapNode,
  iteratorCB: IterateCallback,
): void {
  if (!isFiberNode(node)) {
    return;
  }
  const visited = new Set();
  const stack = [node];
  while (stack.length > 0) {
    const cur = stack.pop();

    if (!cur) {
      continue;
    }

    const ret = iteratorCB(cur);
    visited.add(cur.id);
    if (ret && ret.stop) {
      break;
    }
    iterateChildFiberNodes(cur, child => {
      if (visited.has(child.id)) {
        return;
      }
      stack.push(child);
    });
  }
}

function getNodesIdSet(snapshot: IHeapSnapshot): Set<number> {
  const set: Set<number> = new Set();
  snapshot.nodes.forEach(node => {
    set.add(node.id);
  });
  return set;
}

// given a set of nodes S, return a minimal subset S' where
// no nodes are dominated by nodes in S
function getConditionalDominatorIds(
  ids: Set<number>,
  snapshot: IHeapSnapshot,
  condCb: (node: IHeapNode) => boolean,
): Set<number> {
  const dominatorIds: Set<number> = new Set();
  const fullDominatorIds: Set<number> = new Set();
  // set all node ids
  applyToNodes(ids, snapshot, node => {
    if (condCb(node)) {
      dominatorIds.add(node.id);
      fullDominatorIds.add(node.id);
    }
  });
  // traverse the dominators and remove the node
  // if one of it's dominators is already in the set
  applyToNodes(ids, snapshot, node => {
    const visited = new Set([node.id]);
    let cur = node.dominatorNode;
    while (cur) {
      if (visited.has(cur.id)) {
        break;
      }
      if (fullDominatorIds.has(cur.id)) {
        dominatorIds.delete(node.id);
        break;
      }
      visited.add(cur.id);
      cur = cur.dominatorNode;
    }
  });
  return dominatorIds;
}

type HeapNodeFlag = 0b1 | 0b10;

const ALTERNATE_NODE_FLAG = 0b1;
const REGULAR_NODE_FLAG = 0b10;

function setFiberNodeAttribute(node: Nullable<IHeapNode>, flag: HeapNodeFlag) {
  if (!node || !isFiberNode(node)) {
    return;
  }

  node.attributes |= flag;
}

function hasFiberNodeAttribute(node: IHeapNode, flag: HeapNodeFlag) {
  if (!isFiberNode(node)) {
    return false;
  }
  return !!(node.attributes & flag);
}

function setIsAlternateNode(node: Nullable<IHeapNode>): void {
  setFiberNodeAttribute(node, ALTERNATE_NODE_FLAG);
}

function isAlternateNode(node: IHeapNode): boolean {
  return hasFiberNodeAttribute(node, ALTERNATE_NODE_FLAG);
}

function setIsRegularFiberNode(node: IHeapNode): void {
  setFiberNodeAttribute(node, REGULAR_NODE_FLAG);
}

function isRegularFiberNode(node: IHeapNode): boolean {
  return hasFiberNodeAttribute(node, REGULAR_NODE_FLAG);
}

// The Fiber tree starts with a special type of Fiber node (HostRoot).
function hasHostRoot(node: IHeapNode): boolean {
  if (node && node.is_detached) {
    return false;
  }
  let cur: Optional<IHeapNode> = node;
  const visitedIds = new Set();
  const visitedNodes: Set<IHeapNode> = new Set();
  while (cur && isFiberNode(cur)) {
    if (cur.id == null || visitedIds.has(cur.id)) {
      break;
    }
    visitedNodes.add(cur);
    visitedIds.add(cur.id);
    if (isHostRoot(cur)) {
      return true;
    }
    cur = getReactFiberNode(cur, 'return');
  }
  for (const visitedNode of visitedNodes) {
    visitedNode.markAsDetached();
  }
  return false;
}

type IterateNodeCallback = (
  node: IHeapNode,
  snapshot: IHeapSnapshot,
) => boolean;

function filterNodesInPlace(
  idSet: Set<number>,
  snapshot: IHeapSnapshot,
  cb: IterateNodeCallback,
): void {
  const ids = Array.from(idSet.keys());
  for (const id of ids) {
    const node = snapshot.getNodeById(id);
    if (node && !cb(node, snapshot)) {
      idSet.delete(id);
    }
  }
}

function applyToNodes(
  idSet: Set<number>,
  snapshot: IHeapSnapshot,
  cb: (node: IHeapNode, snapshot: IHeapSnapshot) => void,
  options: AnyOptions = {},
): void {
  let ids = Array.from(idSet.keys());
  if (options.shuffle) {
    ids.sort(() => Math.random() - 0.5);
  } else if (options.reverse) {
    ids = ids.reverse();
  }
  for (const id of ids) {
    const node = snapshot.getNodeById(id);
    if (!node) {
      info.warning(`node @${id} is not found`);
      return;
    }
    cb(node, snapshot);
  }
}

function checkScenarioInstance(s: AnyValue): IScenario {
  if (
    typeof s !== 'object' ||
    typeof s.url !== 'function' ||
    (s.action && typeof s.action !== 'function') ||
    (s.back && typeof s.back !== 'function') ||
    (s.repeat && typeof s.repeat !== 'function') ||
    (s.isPageLoaded && typeof s.isPageLoaded !== 'function') ||
    (s.leakFilter && typeof s.leakFilter !== 'function') ||
    (s.beforeLeakFilter && typeof s.beforeLeakFilter !== 'function') ||
    (s.beforeInitialPageLoad &&
      typeof s.beforeInitialPageLoad !== 'function') ||
    (s.setup && typeof s.setup !== 'function')
  ) {
    throw new Error('Invalid senario');
  }
  return s as IScenario;
}

function loadLeakFilter(filename: string): ILeakFilter {
  const filepath = resolveFilePath(filename);
  if (!filepath || !fs.existsSync(filepath)) {
    // add a throw to silent the type error
    throw haltOrThrow(`Leak filter definition file doesn't exist: ${filepath}`);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    let filter = require(filepath);
    if (typeof filter === 'function') {
      return {leakFilter: filter};
    }
    filter = filter?.default || filter;
    if (typeof filter === 'function') {
      return {leakFilter: filter};
    }
    if (typeof filter?.leakFilter === 'function') {
      return filter;
    }
    throw haltOrThrow(`Invalid leak filter in ${filepath}`);
  } catch (ex) {
    throw haltOrThrow('Invalid leak filter definition file: ' + filename);
  }
}

function loadScenario(filename: string): IScenario {
  const filepath = resolveFilePath(filename);
  if (!filepath || !fs.existsSync(filepath)) {
    // add a throw to silent the type error
    throw haltOrThrow(`Scenario file doesn't exist: ${filepath}`);
  }
  let scenario;
  try {
    scenario = require(filepath);
    scenario = checkScenarioInstance(scenario);
    if (scenario.name == null) {
      scenario.name = () => path.basename(filename);
    }
    return scenario;
  } catch (ex) {
    throw haltOrThrow('Invalid scenario file: ' + filename);
  }
}

function getScenarioName(scenario: IScenario): string {
  if (!scenario.name) {
    return constant.namePrefixForScenarioFromFile;
  }
  if (constant.namePrefixForScenarioFromFile.length > 0) {
    return constant.namePrefixForScenarioFromFile + '-' + scenario.name();
  }
  return scenario.name();
}

function handleSnapshotError(e: Error): void {
  haltOrThrow(e, {
    primaryMessageToPrint: 'Error parsing heap snapshot',
    secondaryMessageToPrint: 'Please pass in a valid heap snapshot file',
  });
}

async function getSnapshotFromFile(
  filename: string,
  options: AnyOptions,
): Promise<IHeapSnapshot> {
  const heapConfig = config.heapConfig;
  if (
    heapConfig &&
    heapConfig.currentHeapFile === filename &&
    heapConfig.currentHeap
  ) {
    return heapConfig.currentHeap;
  }

  info.overwrite('parsing ' + filename + ' ...');
  let ret: Nullable<IHeapSnapshot> = null;
  try {
    ret = await parser.parse(filename, options);
  } catch (e) {
    handleSnapshotError(getError(e));
  }
  info.flush();
  return ret as IHeapSnapshot;
}

async function getSnapshotNodeIdsFromFile(
  filename: string,
  options: AnyOptions,
): Promise<Set<number>> {
  info.overwrite('lightweight parsing ' + filename + ' ...');
  let ret: Set<number> = new Set();
  try {
    ret = await parser.getNodeIdsFromFile(filename, options);
  } catch (e) {
    handleSnapshotError(getError(e));
  }
  return ret;
}

const weakMapKeyRegExp = /@(\d+)\) ->/;

function getWeakMapEdgeKeyId(edge: IHeapEdge): number {
  const name = edge.name_or_index;
  if (typeof name !== 'string') {
    return -1;
  }
  const ret = name.match(weakMapKeyRegExp);
  if (!ret) {
    return -1;
  }
  return Number(ret[1]);
}

function isDocumentDOMTreesRoot(node: IHeapNode): boolean {
  if (!node) {
    return false;
  }
  return node.type === 'synthetic' && node.name === '(Document DOM trees)';
}

function getEdgeByNameAndType(
  node: Nullable<IHeapNode>,
  edgeName: string | number,
  type?: string,
): Nullable<IHeapEdge> {
  if (!node) {
    return null;
  }

  return node.findAnyReference(
    (edge: IHeapEdge) =>
      edge.name_or_index === edgeName &&
      (type === undefined || edge.type === type),
  );
}

function getEdgeStartsWithName(
  node: Nullable<IHeapNode>,
  prefix: string,
): Nullable<IHeapEdge> {
  if (!node) {
    return null;
  }
  return node.findAnyReference(
    edge =>
      typeof edge.name_or_index === 'string' &&
      edge.name_or_index.startsWith(prefix),
  );
}

function isStringNode(node: IHeapNode): boolean {
  return isHeapStringType(node.type);
}

function isSlicedStringNode(node: IHeapNode): boolean {
  return node.type === 'sliced string';
}

function getStringNodeValue(node: Optional<IHeapNode>): string {
  if (!node) {
    return '';
  }

  if (node.type === 'concatenated string') {
    const firstNode = getEdgeByNameAndType(node, 'first')?.toNode;
    const secondNode = getEdgeByNameAndType(node, 'second')?.toNode;
    return getStringNodeValue(firstNode) + getStringNodeValue(secondNode);
  }

  if (isSlicedStringNode(node)) {
    const parentNode = getEdgeByNameAndType(node, 'parent')?.toNode;
    return getStringNodeValue(parentNode);
  }

  return node.name;
}

function extractClosureNodeInfo(node: IHeapNode): string {
  let name = _extractClosureNodeInfo(node);
  // replace all [, ], (, and )
  name = name.replace(/[[\]()]/g, '');
  return name;
}

function _extractClosureNodeInfo(node: IHeapNode): string {
  if (!node) {
    return '';
  }
  const name = node.name === '' ? '<anonymous>' : node.name;
  if (node.type !== 'closure') {
    return name;
  }
  // node.shared
  const sharedEdge = getEdgeByNameAndType(node, 'shared');
  if (!sharedEdge) {
    return name;
  }
  // node.shared.function_data
  const sharedNode = sharedEdge.toNode;
  const functionDataEdge = getEdgeByNameAndType(sharedNode, 'function_data');
  if (!functionDataEdge) {
    return name;
  }
  // node.shared.function_data[0]
  const functionDataNode = functionDataEdge.toNode;
  const displaynameEdge = getEdgeByNameAndType(functionDataNode, 0, 'hidden');
  if (!displaynameEdge) {
    return name;
  }
  // extract display name
  const displayNameNode = displaynameEdge.toNode;
  if (
    displayNameNode.type === 'concatenated string' ||
    displayNameNode.type === 'string' ||
    displayNameNode.type === 'sliced string'
  ) {
    const str = getStringNodeValue(displayNameNode);
    if (str !== '') {
      return `${name} ${str}`;
    }
  }
  return name;
}

function extractFiberNodeInfo(node: IHeapNode): string {
  let name = _extractFiberNodeInfo(node);
  const tagName = _extractFiberNodeTagInfo(node);
  if (tagName) {
    name += ` ${tagName}`;
  }
  // simplify redundant pattern:
  //  "(Detached )FiberNode X from X.react" -> "(Detached )FiberNode X"
  const detachedPrefix = 'Detached ';
  let prefix = '';
  if (name.startsWith(detachedPrefix)) {
    prefix = detachedPrefix;
    name = name.substring(detachedPrefix.length);
  }
  const matches = name.match(/^FiberNode (\w+) \[from (\w+)\.react\]$/);
  if (matches && matches[1] === matches[2]) {
    name = `FiberNode ${matches[1]}`;
  }
  // replace all [, ], (, and )
  name = name.replace(/[[\]()]/g, '');
  return prefix + name;
}

function getNumberNodeValue(node: IHeapNode): Nullable<number> {
  if (!node) {
    return null;
  }
  if (config.jsEngine === 'hermes') {
    return +node.name;
  }
  const valueNode = getToNodeByEdge(node, 'value', 'internal');
  if (!valueNode) {
    return null;
  }
  return +valueNode.name;
}

function getBooleanNodeValue(node: IHeapNode): Nullable<boolean> {
  if (node === null || node === undefined) {
    return null;
  }
  if (config.jsEngine === 'hermes') {
    return node.name === 'true';
  }
  const valueNode = getToNodeByEdge(node, 'value', 'internal');
  if (valueNode === null || valueNode === undefined) {
    return null;
  }
  return valueNode.name === 'true';
}

function _extractFiberNodeTagInfo(node: IHeapNode): Nullable<string> {
  if (!node) {
    return null;
  }
  if (!isFiberNode(node)) {
    return null;
  }
  const tagNode = getToNodeByEdge(node, 'tag', 'property');
  if (!tagNode) {
    return null;
  }
  if (tagNode.type !== 'number') {
    return null;
  }
  const tagId = getNumberNodeValue(tagNode);
  return _getReactWorkTagName(tagId);
}

function getToNodeByEdge(
  node: Nullable<IHeapNode>,
  propName: string,
  propType?: string,
): Nullable<IHeapNode> {
  const edge = getEdgeByNameAndType(node, propName, propType);
  if (!edge) {
    return null;
  }
  return edge.toNode;
}

function getSymbolNodeValue(node: Nullable<IHeapNode>): Nullable<string> {
  if (!node || node.name !== 'symbol') {
    return null;
  }
  const nameNode = getToNodeByEdge(node, 'name');
  if (!nameNode) {
    return null;
  }
  return nameNode.name;
}

function _extractFiberNodeInfo(node: IHeapNode): string {
  if (!node) {
    return '';
  }
  const name = node.name;
  if (!isFiberNode(node)) {
    return name;
  }
  // extract FiberNode.type
  const typeNode = getToNodeByEdge(node, 'type', 'property');
  if (!typeNode) {
    return name;
  }
  if (typeNode.type === 'string') {
    return `${name} ${typeNode.name}`;
  }
  // extract FiberNode.type.render
  const renderNode = getToNodeByEdge(typeNode, 'render');
  if (renderNode && renderNode.name) {
    return `${name} ${renderNode.name}`;
  }
  // if FiberNode.type or FiberNode.elementType is a symbol
  let value = getSymbolNodeValue(typeNode);
  if (value) {
    return `${name} ${value}`;
  }
  const elementTypeNode = getToNodeByEdge(node, 'elementType', 'property');
  value = getSymbolNodeValue(elementTypeNode);
  if (value) {
    return `${name} ${value}`;
  }
  // extract FiberNode.elementType.$$typeof
  const typeofNode = getToNodeByEdge(elementTypeNode, '$$typeof', 'property');
  value = getSymbolNodeValue(typeofNode);
  if (value) {
    return `${name} ${value}`;
  }
  // extract FiberNode.type.displayName
  const displayNameNode = getToNodeByEdge(typeNode, 'displayName');
  if (!displayNameNode) {
    return name;
  }
  if (displayNameNode.type === 'string') {
    return `${name} ${displayNameNode.name}`;
  }
  if (displayNameNode.type === 'concatenated string') {
    return `${name} ${getStringNodeValue(displayNameNode)}`;
  }
  return name;
}

function extractHTMLElementNodeInfo(node: IHeapNode): string {
  if (!node) {
    return '';
  }
  const reactFiberEdge = getEdgeStartsWithName(node, '__reactFiber$');
  if (!reactFiberEdge) {
    return node.name;
  }
  return `${node.name} ${extractFiberNodeInfo(reactFiberEdge.toNode)}`;
}

function hasOnlyWeakReferrers(node: IHeapNode): boolean {
  const referrer = node.findAnyReferrer(
    // shortcut references are added by JS engine
    // GC won't consider shortcut as a retaining edge
    (edge: IHeapEdge) => edge.type !== 'weak' && edge.type !== 'shortcut',
  );
  return referrer == null;
}

function getRunMetaFilePath(): string {
  return config.useExternalSnapshot
    ? config.externalRunMetaFile
    : config.runMetaFile;
}

function loadRunMetaInfo(metaFile: Optional<string> = undefined): RunMetaInfo {
  const file = metaFile || getRunMetaFilePath();
  try {
    const content = fs.readFileSync(file, 'UTF-8');
    return JSON.parse(content) as RunMetaInfo;
  } catch (_) {
    throw haltOrThrow(
      'Run info missing. Please make sure `memlab run` is complete.',
    );
  }
}

function loadTargetInfoFromRunMeta(): void {
  const meta = loadRunMetaInfo();
  config.targetApp = meta.app;
  config.targetTab = meta.interaction;
  browserInfo.load(meta.browserInfo);
}

function getSnapshotSequenceFilePath(): string {
  if (!config.useExternalSnapshot) {
    // load the snapshot sequence meta file from the default location
    return config.snapshotSequenceFile;
  }
  if (config.externalSnapshotDir) {
    // try to load the snap-seq.json file from the specified external dir
    const metaFile = path.join(config.externalSnapshotDir, 'snap-seq.json');
    if (fs.existsSync(metaFile)) {
      return metaFile;
    }
  }
  // otherwise return the default meta file for external snapshots
  return config.externalSnapshotVisitOrderFile;
}

// this should be called only after exploration
function loadTabsOrder(metaFile: Optional<string> = undefined): E2EStepInfo[] {
  try {
    const file = metaFile || getSnapshotSequenceFilePath();
    const content = fs.readFileSync(file, 'UTF-8');
    return JSON.parse(content);
  } catch {
    throw haltOrThrow('snapshot meta data invalid or missing');
  }
}

// if true the leak trace is will be reported
function isInterestingPath(p: LeakTracePathItem): boolean {
  // do not filter paths when analyzing Hermes snapshots
  if (config.jsEngine === 'hermes') {
    return true;
  }
  // if the path has pattern: Window -> [InternalNode]+ -> DetachedElement
  if (config.hideBrowserLeak && internalNodeRetainsDetachedElement(p)) {
    return false;
  }
  // if the path has pattern: ShadowRoot -> DetachedElement
  if (config.hideBrowserLeak && shadowRootRetainsDetachedElement(p)) {
    return false;
  }
  // if the path has pattern: StyleEngine -> InternalNode -> DetachedElement
  if (config.hideBrowserLeak && styleEngineRetainsDetachedElement(p)) {
    return false;
  }
  // if the path has pattern: Pending activitiies -> DetachedElement
  if (
    config.hideBrowserLeak &&
    pendingActivitiesRetainsDetachedElementChain(p)
  ) {
    return false;
  }
  return true;
}

// return true if the heap node represents JS object or closure
function isObjectNode(node: IHeapNode): boolean {
  if (isPlainJSObjectNode(node)) {
    return true;
  }
  return node.type === 'closure';
}

// return true if the heap node represents JS object
function isPlainJSObjectNode(node: IHeapNode): boolean {
  if (!node) {
    return false;
  }
  if (config.jsEngine === 'hermes') {
    return node.name === 'Object' || node.name.startsWith('Object(');
  }

  return node.name === 'Object';
}

// check if the path has pattern:
// Window -> [InternalNode | Text]+ -> DetachedElement
function internalNodeRetainsDetachedElement(path: LeakTracePathItem): boolean {
  if (!path) {
    return false;
  }
  let p: Optional<LeakTracePathItem> = path;
  // GC root is not Window
  if (!p.node || !p.node.name.startsWith('Window')) {
    return false;
  }
  p = p.next;
  // Window is not poining to InternalNode
  if (!p || !p.node || p.node.name !== 'InternalNode') {
    return false;
  }
  // skip the rest InternalNode
  while (p.node?.name === 'InternalNode' || p.node?.name === 'Text') {
    p = p.next;
    if (!p) {
      return false;
    }
  }
  // check if the node is a detached element
  return p && isDetachedDOMNode(p.node);
}

// check if the path has pattern: ShadowRoot -> DetachedElement
function shadowRootRetainsDetachedElement(path: LeakTracePathItem): boolean {
  let p: Optional<LeakTracePathItem> = path;
  // find the ShadowRoot
  while (p && p.node && p.node.name !== 'ShadowRoot') {
    p = p.next;
    if (!p) {
      return false;
    }
  }
  p = p.next;
  // check if the node is a detached element
  return !!p && isDetachedDOMNode(p.node);
}

// check if the path has pattern: StyleEngine -> InternalNode -> DetachedElement
function styleEngineRetainsDetachedElement(path: LeakTracePathItem): boolean {
  let p: Optional<LeakTracePathItem> = path;
  // find the StyleEngine
  while (p && p.node && p.node.name !== 'StyleEngine') {
    p = p.next;
    if (!p) {
      return false;
    }
  }
  p = p.next;
  // StyleEngine is not poining to InternalNode
  if (!p || !p.node || p.node.name !== 'InternalNode') {
    return false;
  }
  p = p.next;
  // check if the InternalNode is pointing to a detached element
  return !!p && isDetachedDOMNode(p.node);
}

function pendingActivitiesRetainsDetachedElementChain(
  path: LeakTracePathItem,
): boolean {
  let p: Optional<LeakTracePathItem> = path;
  // find the Pending activities
  while (p && p.node && !isPendingActivityNode(p.node)) {
    p = p.next;
    if (!p) {
      return false;
    }
  }
  p = p.next;
  if (!p || !p.node) {
    return false;
  }
  // all the following reference chain is detached DOM elements
  // pointing to other detached DOM elements
  while (p && p.node) {
    if (!isDetachedDOMNode(p.node)) {
      return false;
    }
    p = p.next;
  }
  return true;
}

function pathHasDetachedHTMLNode(path: LeakTracePathItem): boolean {
  if (!path) {
    return false;
  }
  let p: Optional<LeakTracePathItem> = path;
  while (p) {
    if (p.node && isDetachedDOMNode(p.node)) {
      return true;
    }
    p = p.next;
  }
  return false;
}

function pathHasEdgeWithIndex(path: LeakTracePathItem, idx: number): boolean {
  if (!path || typeof idx !== 'number') {
    return false;
  }
  let p: Optional<LeakTracePathItem> = path;
  while (p) {
    if (p.edge && p.edge.edgeIndex === idx) {
      return true;
    }
    p = p.next;
  }
  return false;
}

function getLastNodeId(path: LeakTracePathItem): number {
  if (!path) {
    return -1;
  }
  let p: Optional<LeakTracePathItem> = path;
  while (p) {
    if (!p.next && p.node) {
      return p.node.id;
    }
    p = p.next;
  }
  return -1;
}

function getReadablePercent(num: number): string {
  if (Number.isNaN(num)) {
    return `${num}%`;
  }
  const v = num * 100;
  let str = v.toFixed(2);
  if (str.endsWith('.00')) {
    str = str.slice(0, -3);
  } else if (str.endsWith('0')) {
    str = str.slice(0, -1);
  }
  return str + '%';
}

function getReadableBytes(bytes: Optional<number>): string {
  let n: number, suffix: string;
  if (bytes === undefined || bytes === null) {
    return '';
  }
  if (bytes >= 1e12) {
    n = ((bytes / 1e11) | 0) / 10;
    suffix = 'TB';
  } else if (bytes >= 1e9) {
    n = ((bytes / 1e8) | 0) / 10;
    suffix = 'GB';
  } else if (bytes >= 1e6) {
    n = ((bytes / 1e5) | 0) / 10;
    suffix = 'MB';
  } else if (bytes >= 1e3) {
    n = ((bytes / 1e2) | 0) / 10;
    suffix = 'KB';
  } else if (bytes > 1) {
    n = bytes;
    suffix = ' bytes';
  } else if (bytes >= 0) {
    n = bytes;
    suffix = ' byte';
  } else {
    return '';
  }
  return n + suffix;
}

function p1(n: number, divide: number): number {
  return (((n * 10) / divide) | 0) / 10;
}

function getReadableTime(ms: number): string {
  let time = ms;
  if (time < 1000) {
    return `${time}ms`;
  }
  time /= 1000;
  if (time < 60) {
    return `${p1(time, 1)}s`;
  }
  time /= 60;
  if (time < 60) {
    return `${p1(time, 1)}min`;
  }
  time /= 60;
  if (time < 24) {
    return `${p1(time, 1)}hr`;
  }
  time /= 24;
  return `${p1(time, 1)} days`;
}

function shouldShowMoreInfo(node: IHeapNode): boolean {
  if (!node || !node.name) {
    return false;
  }
  if (!config.nodeToShowMoreInfo) {
    return false;
  }
  return config.nodeToShowMoreInfo.has(node.name);
}

function isDebuggableNode(node: IHeapNode): boolean {
  if (!node) {
    return false;
  }
  if (node.type === 'native' && !isDetachedDOMNode(node)) {
    return false;
  }
  if (
    node.type === 'hidden' ||
    node.type === 'array' ||
    node.type === 'string' ||
    node.type === 'number' ||
    node.type === 'concatenated string' ||
    node.type === 'sliced string' ||
    node.type === 'code' ||
    node.name === 'system / Context'
  ) {
    return false;
  }
  return true;
}

function throwError(error: Error): void {
  if (error) {
    error.stack;
  }
  throw error;
}

function callAsync(f: AnyAyncFunction): void {
  const promise = f();
  if (promise && promise.catch) {
    promise.catch((e: unknown) => {
      const parsedError = getError(e);
      info.error(parsedError.message);
      info.lowLevel(parsedError.stack ?? '');
    });
  }
}

function checkUninstalledLibrary(ex: Error): void {
  const stackStr = ex.stack?.toString();
  if (stackStr?.includes('cannot open shared object file')) {
    haltOrThrow(ex, {
      primaryMessageToPrint:
        'Could not launch Chrome. To run MemLab on a CentOS 8 devserver, please run the following command:\n',
      secondaryMessageToPrint:
        'sudo dnf install nss libwayland-client libwayland-egl egl-wayland libpng15 mesa-libGL atk java-atk-wrapper at-spi2-atk gtk3 libXt',
    });
  }
}

async function closePuppeteer(
  browser: Browser,
  pages: Page[],
  options: AnyOptions = {},
): Promise<void> {
  if (config.isLocalPuppeteer && !options.warmup) {
    await Promise.all(pages.map(page => page.close()));
    await browser.disconnect();
  } else {
    await browser.close();
  }
}

function camelCaseToReadableString(str: string): string {
  let ret = '';
  const isUpperCase = (c: string) => /^[A-Z]$/.test(c);
  for (const c of str) {
    if (isUpperCase(c)) {
      ret += ret.length > 0 ? ' ' : '';
      ret += c.toLowerCase();
    } else {
      ret += c;
    }
  }
  return ret;
}

// Given a file path (relative or absolute),
// this function tries to resolve to a absolute path that exists
// in MemLab's directories.
// if nothing is found, it returns null.
function resolveFilePath(file: string | null): Nullable<string> {
  if (!file) {
    return null;
  }
  const dirs = [
    config.curDataDir,
    config.persistentDataDir,
    config.monoRepoDir,
  ];
  const paths = [file].concat(dirs.map(d => path.join(d, file)));
  for (const p of paths) {
    const filepath = path.resolve(p);
    if (fs.existsSync(filepath)) {
      return filepath;
    }
  }
  return null;
}

const snapshotNamePattern = /^s(\d+)\.heapsnapshot$/;
function compareSnapshotName(f1: string, f2: string) {
  // if file name follows the 's{\d+}.heapsnapshot' pattern
  // then order based on the ascending order of the number
  const m1 = f1.match(snapshotNamePattern);
  const m2 = f2.match(snapshotNamePattern);
  if (m1 && m2) {
    return parseInt(m1[1], 10) - parseInt(m2[1], 10);
  }
  // otherwise sort in alpha numeric order
  return f1 < f2 ? -1 : f1 === f2 ? 0 : 1;
}

function getSnapshotFilesInDir(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter(file => file.endsWith('.heapsnapshot'))
      .sort(compareSnapshotName)
      .map(file => path.join(dir, file));
  } catch (ex) {
    throw utils.haltOrThrow(utils.getError(ex));
  }
}

function getSnapshotFilesFromTabsOrder(options: AnyOptions = {}): string[] {
  const tabsOrder = loadTabsOrder();
  const ret = [];
  const typesSeen = new Set();
  for (let i = 0; i < tabsOrder.length; i++) {
    const tab = tabsOrder[i];
    if (!tab.snapshot) {
      continue;
    }
    if (tab.type) {
      typesSeen.add(tab.type);
    }
    if (
      options.skipBeforeTabType &&
      !typesSeen.has(options.skipBeforeTabType)
    ) {
      continue;
    }
    ret.push(getSnapshotFilePath(tab));
  }
  return ret;
}

// checks if the snapshots along with their meta data are complete
function checkSnapshots(
  options: {snapshotDir?: Optional<string>; minSnapshots?: number} = {},
): void {
  if (config.skipSnapshot) {
    haltOrThrow(
      'This command is run with `--no-snapshot`, skip snapshot check.',
    );
  }

  let snapshotDir: string;
  if (options.snapshotDir) {
    snapshotDir = options.snapshotDir;
  } else if (config.useExternalSnapshot) {
    snapshotDir = config.externalSnapshotDir || '<missing>';
  } else {
    snapshotDir = fileManager.getCurDataDir({workDir: config.workDir});
  }

  if (options.snapshotDir) {
    const snapshots = getSnapshotFilesInDir(snapshotDir);
    const min = options.minSnapshots || 1;
    if (snapshots.length < min) {
      utils.haltOrThrow(
        `Directory has < ${min} snapshot files: ${options.snapshotDir}`,
      );
    }
    return;
  }

  // check if any snapshot file is missing
  const tabsOrder = loadTabsOrder();
  const missingTabs = Object.create(null);
  let miss = 0;
  for (const tab of tabsOrder) {
    if (!tab.snapshot) {
      continue;
    }

    const file = getSnapshotFilePath(tab);
    if (!fs.existsSync(file)) {
      ++miss;
      missingTabs[tab.idx] = {
        name: tab.name,
        url: tab.url,
        type: tab.type,
      };
    }
  }
  if (miss > 0) {
    const msg = 'snapshot for the following tabs are missing:';
    const printCallback = () => {
      info.warning(msg);
      info.table(missingTabs);
    };
    haltOrThrow(msg + JSON.stringify(missingTabs, null, 2), {
      printCallback,
    });
  }
}

export function resolveSnapshotFilePath(
  snapshotFile: Nullable<string>,
): string {
  const file = resolveFilePath(snapshotFile);
  if (!file) {
    throw haltOrThrow(
      new Error(`Error: snapshot file doesn't exist ${snapshotFile}`),
    );
  }
  return file;
}

function getSnapshotDirForAnalysis(): string {
  const dir = config.externalSnapshotDir;
  if (!dir) {
    throw utils.haltOrThrow(new Error('external snapshot file not set'));
  }
  return dir;
}

function getSingleSnapshotFileForAnalysis(): string {
  let path: Nullable<string> = null;

  // if an external snapshot file is specified
  if (
    config.useExternalSnapshot &&
    config.externalSnapshotFilePaths.length > 0
  ) {
    path =
      config.externalSnapshotFilePaths[
        config.externalSnapshotFilePaths.length - 1
      ];

    // if running in interactive heap analysis mode
  } else if (
    config.heapConfig &&
    config.heapConfig.isCliInteractiveMode &&
    config.heapConfig.currentHeapFile
  ) {
    path = config.heapConfig.currentHeapFile;

    // search for snapshot labeled as baseline, target, or final
  } else {
    path = getSnapshotFilePathWithTabType(/(final)|(target)|(baseline)/);
  }
  return resolveSnapshotFilePath(path);
}

function getSnapshotFilePath(
  tab: E2EStepInfo,
  options: {workDir?: string} = {},
): string {
  const fileName = `s${tab.idx}.heapsnapshot`;
  if (options.workDir) {
    return path.join(fileManager.getCurDataDir(options), fileName);
  }
  if (!config.useExternalSnapshot) {
    return path.join(config.curDataDir, fileName);
  }
  // if we are loading snapshot from external snapshot dir
  if (config.externalSnapshotDir) {
    return path.join(config.externalSnapshotDir, fileName);
  }
  return config.externalSnapshotFilePaths[tab.idx - 1];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function equalOrMatch(v1: any, v2: any): boolean {
  const t1 = typeof v1;
  const t2 = typeof v2;
  if (t1 === t2) {
    return v1 === v2;
  }
  if (t1 === 'string' && v2 instanceof RegExp) {
    return v2.test(v1 as string);
  }
  if (t2 === 'string' && v1 instanceof RegExp) {
    return v1.test(v2 as string);
  }
  return false;
}

function getSnapshotFilePathWithTabType(
  type: string | RegExp,
): Nullable<string> {
  checkSnapshots();
  const tabsOrder = loadTabsOrder();
  for (let i = tabsOrder.length - 1; i >= 0; --i) {
    const tab = tabsOrder[i];
    if (!tab.snapshot) {
      continue;
    }
    if (equalOrMatch(tab.type, type)) {
      return getSnapshotFilePath(tab);
    }
  }
  return null;
}

function isMeaningfulNode(node: IHeapNode): boolean {
  if (!node) {
    return false;
  }
  const nodeName = node.name;
  if (config.nodeNameBlockList.has(nodeName)) {
    return false;
  }
  if (isFiberNode(node)) {
    const displayName = extractFiberNodeInfo(node);
    if (config.nodeNameBlockList.has(displayName)) {
      return false;
    }
  }

  // More details in https://github.com/ChromeDevTools/devtools-frontend
  // under front_end/heap_snapshot_worker/HeapSnapshot.ts
  if (nodeName === 'system / NativeContext') {
    return false;
  }
  if (nodeName === 'system / SourcePositionTableWithFrameCache') {
    return false;
  }
  if (nodeName === '(map descriptors)') {
    return false;
  }
  if (node.type === 'code') {
    return false;
  }
  return true;
}

interface IsMeaningFulEdgeParams {
  visited?: Uint8Array;
  queued?: Uint8Array;
  includeString?: boolean;
  excludeWeakMapEdge?: boolean;
  isForward?: boolean;
}

function isMeaningfulEdge(
  edge: IHeapEdge,
  options: IsMeaningFulEdgeParams = {},
): boolean {
  const node = options.isForward ? edge.toNode : edge.fromNode;
  const source = options.isForward ? edge.fromNode : edge.toNode;
  // exclude self references
  if (source.id === node.id) {
    return false;
  }
  const edgeNameOrIndex = edge.name_or_index;
  if (
    typeof edgeNameOrIndex === 'string' &&
    config.edgeNameBlockList.has(edgeNameOrIndex)
  ) {
    return false;
  }
  const edgeType = edge.type;
  // shortcut edge may be meaningful edges
  // --forceUpdate (variable)--->  [native_bind]
  // --bound_argument_0 (shortcut)--->  [FiberNode]
  if (edgeType === 'weak' /* || edge.type === 'shortcut' */) {
    return false;
  }
  if (options.excludeWeakMapEdge && isWeakMapEdgeToKey(edge)) {
    return false;
  }
  const nodeIndex = node.nodeIndex;
  if (options.visited && options.visited[nodeIndex]) {
    return false;
  }
  if (options.queued && options.queued[nodeIndex]) {
    return false;
  }
  const nodeType = node.type;
  if (!options.includeString && nodeType === 'string') {
    return false;
  }
  if (edgeType === 'internal' && edgeNameOrIndex === 'code') {
    return false;
  }

  // More details about the following three special cases are available
  // in https://github.com/ChromeDevTools/devtools-frontend
  // under front_end/heap_snapshot_worker/HeapSnapshot.ts
  if (edgeType === 'hidden' && edgeNameOrIndex === 'sloppy_function_map') {
    return false;
  }
  const nodeName = node.name;
  if (edgeType === 'hidden' && nodeName === 'system / NativeContext') {
    return false;
  }
  // In v8, (map descriptors) are fixed-length descriptors arrays used
  // to hold JS descriptors.
  if (edgeType === 'array' && nodeName === '(map descriptors)') {
    const index = edgeNameOrIndex;
    // only elements at particular indexes of (map descriptors) are holding
    // representative references to objects.
    if (index >= 2 || (typeof index === 'number' && index % 3 === 1)) {
      return false;
    }
  }

  if (!isMeaningfulNode(node)) {
    return false;
  }
  if (config.jsEngine === 'hermes' && isDirectPropEdge(edge)) {
    return false;
  }
  if (config.ignoreInternalNode && nodeName.includes('InternalNode')) {
    return false;
  }
  if (config.ignoreDevToolsConsoleLeak) {
    if (
      typeof edgeNameOrIndex === 'string' &&
      edgeNameOrIndex.includes('DevTools console')
    ) {
      return false;
    }
  }
  return true;
}

// check if two URLs are equivalent
// for example, the following pairs are equal
// 'https://test.com/?a=1&b=2&a=3', 'https://test.com?b=2&a=3&a=1'
// 'https://test.com/p1/p2?a=1,b=2', 'https://test.com/p1/p2/?a=1,b=2'
function isURLEqual(url1: string, url2: string): boolean {
  let u1: URL, u2: URL;
  try {
    u1 = new URL(url1);
    u2 = new URL(url2);
  } catch (_e) {
    return false;
  }

  // compare URL fields
  if (
    u1.protocol !== u2.protocol ||
    u1.host !== u2.host ||
    u1.hostname !== u2.hostname ||
    u1.port !== u2.port ||
    u1.hash !== u2.hash
  ) {
    return false;
  }

  // compare path
  let p1 = u1.pathname;
  p1 = p1.endsWith('/') ? p1.slice(0, -1) : p1;
  let p2 = u2.pathname;
  p2 = p2.endsWith('/') ? p2.slice(0, -1) : p2;
  if (p1 !== p2) {
    return false;
  }

  // compare URL params
  const paramKeys = new Set([
    ...Array.from(u1.searchParams.keys()),
    ...Array.from(u2.searchParams.keys()),
  ]);
  for (const key of paramKeys) {
    const v1 = u1.searchParams.getAll(key).sort().join(' ');
    const v2 = u2.searchParams.getAll(key).sort().join(' ');
    if (v1 !== v2) {
      return false;
    }
  }
  return true;
}

function shuffleArray<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function getLeakedNode(path: LeakTracePathItem): IHeapNode | null {
  let p = path;
  const set = new Set([p]);
  while (p.next && !set.has(p.next)) {
    set.add(p.next);
    p = p.next;
  }
  if (!p || !p.node) {
    return null;
  }
  return p.node;
}

// print snapshot to file for local testing
function dumpSnapshot(file: string, snapshot: RawHeapSnapshot): void {
  fs.writeFileSync(
    file,
    JSON.stringify(snapshot.snapshot.meta, null, 0),
    'UTF-8',
  );

  const dumpSection = (name: string, arr: number[]) => {
    let buf = '';
    fs.appendFileSync(file, `\n\n ${name}:\n\n`, 'UTF-8');
    for (let i = 0; i < arr.length; ++i) {
      buf += arr[i] + ',';
      if (buf.length > 1024 * 1024) {
        fs.appendFileSync(file, '\n\n' + buf, 'UTF-8');
        buf = '';
      }
    }
    fs.appendFileSync(file, '\n\n' + buf, 'UTF-8');
    buf = '';
  };

  dumpSection('nodes', snapshot.nodes);
  dumpSection('edges', snapshot.edges);
  dumpSection('locations', snapshot.locations);
}

function markAllDetachedFiberNode(snapshot: IHeapSnapshot): void {
  info.overwrite('marking all detached Fiber nodes...');
  snapshot.nodes.forEach(node => {
    // hasHostRoot checks and marks detached Fiber Nodes
    isFiberNode(node) && !hasHostRoot(node);
  });
}

function markAlternateFiberNode(snapshot: IHeapSnapshot): void {
  info.overwrite('marking alternate Fiber nodes...');
  snapshot.nodes.forEach(node => {
    // mark the fiber root node
    if (!isHostRoot(node)) {
      return;
    }
    iterateDescendantFiberNodes(node, (descendant: IHeapNode): void => {
      // check if the node is doubly linked to its parent
      if (checkIsChildOfParent(descendant)) {
        setIsRegularFiberNode(descendant);
      }
      // mark explicit alternate fiber node
      setIsAlternateNode(getToNodeByEdge(descendant, 'alternate', 'property'));
    });
  });
}

function getAllDominators(node: IHeapNode): Array<IHeapNode> {
  const visited = new Set();
  const dominators = [];
  let cur: Nullable<IHeapNode> = node;
  while (cur && !visited.has(cur.id)) {
    visited.add(cur.id);
    dominators.push(cur);
    cur = cur.dominatorNode;
  }
  return dominators;
}

function upperCaseFirstCharacter(text: string): string {
  if (text.length === 0) {
    return text;
  }
  return text[0].toUpperCase() + text.substring(1);
}

function repeat(str: string, n: number): string {
  let ret = '';
  for (let i = 0; i < n; ++i) {
    ret += str;
  }
  return ret;
}

function normalizeBaseUrl(url: string): string {
  let ret = url;
  if (
    url.length > 0 &&
    !url.endsWith('.html') &&
    !url.endsWith('.htm') &&
    !url.endsWith('/')
  ) {
    ret += '/';
  }
  return ret;
}

function haltOrThrow(
  errorInfo: string | Error,
  options: HaltOrThrowOptions = {},
): never {
  const err = getError(errorInfo);
  const halt = async () => {
    if (options.printErrorBeforeHalting !== false) {
      // only print the error.message when there is no
      // primary message to print or there is no print callback
      if (!options.primaryMessageToPrint && !options.printCallback) {
        info.error(err.message);
      }
      // only print stack trace in verbose mode
      if (config.verbose) {
        info.lowLevel(err.stack ?? '');
      } else {
        info.topLevel(
          'Use `memlab help` or `memlab <COMMAND> -h` to get helper text',
        );
      }
      if (options.primaryMessageToPrint) {
        info.error(options.primaryMessageToPrint);
      }
      if (options.secondaryMessageToPrint) {
        info.lowLevel(options.secondaryMessageToPrint);
      }
      if (options.printCallback) {
        options.printCallback();
      }
    }
    throw process.exit(1);
  };
  const throwErr = () => {
    let message = '';
    // show primary message
    if (options.primaryMessageToPrint) {
      message = options.primaryMessageToPrint;
    } else {
      message = err.message;
    }
    // append secondary message
    if (options.secondaryMessageToPrint) {
      message += `(${options.secondaryMessageToPrint})`;
    }
    // if already specified a primary message,
    // append the error.message at the end
    if (options.primaryMessageToPrint) {
      if (message.length > 0 && !message.endsWith('.')) {
        message += '. ';
      }
      message += err.message;
    }
    err.message = message;
    throw err;
  };
  const handling = options?.errorHandling ?? config.errorHandling;
  switch (handling) {
    case ErrorHandling.Halt:
      halt();
      break;
    case ErrorHandling.Throw:
      throwErr();
      break;
  }
  throw 'unreachable';
}

function getError(maybeError: unknown): Error {
  if (maybeError instanceof Error) {
    return maybeError;
  }
  return convertToError(maybeError);
}

function convertToError(maybeError: unknown): Error {
  if (isErrorWithMessage(maybeError)) {
    return new Error(maybeError.message);
  }

  try {
    const msg =
      typeof maybeError === 'string' ? maybeError : JSON.stringify(maybeError);
    return new Error(msg);
  } catch {
    // fallback in case there's an error stringifying the maybeError
    // like with circular references for example.
    return new Error(String(maybeError));
  }
}

function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

// check if a node is dominated by an array referenced as 'deletions'
// React stores unmounted fiber nodes that will be deleted soon in
// a 'deletions' array.
function isNodeDominatedByDeletionsArray(node: IHeapNode): boolean {
  const dominators = getAllDominators(node);
  return dominators.some(dominator => {
    const edges = dominator.referrers;
    return edges.some(e => e.name_or_index === 'deletions');
  });
}

let uindex = 1;
function getUniqueID(): string {
  return `${process.pid}-${Date.now()}-${uindex++}`;
}

// try to get the url that defines the closure function
// this is particular to heap snapshot taken from V8 in Chromium
function getClosureSourceUrl(node: IHeapNode): Nullable<string> {
  if (node.type !== 'closure') {
    return null;
  }
  const shared = node.getReferenceNode('shared', 'internal');
  if (!shared) {
    return null;
  }
  const debug = shared.getReferenceNode('script_or_debug_info', 'internal');
  if (!debug) {
    return null;
  }
  const urlNode = debug.getReferenceNode('name', 'internal');
  const url = urlNode?.toStringNode()?.stringValue ?? null;
  return url;
}

export function runShell(
  command: string,
  options: ShellOptions = {},
): Nullable<string> {
  const runningDir = options.dir ?? config.workDir ?? fileManager.getTmpDir();
  const execOptions: cp.ExecSyncOptions = {
    cwd: runningDir,
    stdio: options.disconnectStdio
      ? []
      : [process.stdin, process.stdout, process.stderr],
  };
  if (process.platform !== 'win32') {
    execOptions.shell = '/bin/bash';
  }
  let ret: Nullable<Buffer | string> = null;
  try {
    ret = cp.execSync(command, execOptions);
  } catch (ex) {
    if (config.verbose) {
      if (ex instanceof Error) {
        info.lowLevel(ex.message);
        info.lowLevel(ex.stack ?? '');
      }
    }
    if (options.ignoreError === true) {
      return '';
    }
    utils.haltOrThrow(`Error when executing command: ${command}`);
  }
  return ret && ret.toString('UTF-8');
}

export function getRetainedSize(node: IHeapNode): number {
  return node.retainedSize;
}

export function aggregateDominatorMetrics(
  ids: HeapNodeIdSet,
  snapshot: IHeapSnapshot,
  checkNodeCb: (node: IHeapNode) => boolean,
  nodeMetricsCb: (node: IHeapNode) => number,
) {
  let ret = 0;
  const dominators = utils.getConditionalDominatorIds(
    ids,
    snapshot,
    checkNodeCb,
  );
  utils.applyToNodes(dominators, snapshot, node => {
    ret += nodeMetricsCb(node);
  });
  return ret;
}

export default {
  aggregateDominatorMetrics,
  applyToNodes,
  callAsync,
  camelCaseToReadableString,
  checkSnapshots,
  checkUninstalledLibrary,
  checkIsChildOfParent,
  closePuppeteer,
  dumpSnapshot,
  equalOrMatch,
  extractClosureNodeInfo,
  extractFiberNodeInfo,
  extractHTMLElementNodeInfo,
  filterNodesInPlace,
  getAllDominators,
  getClosureSourceUrl,
  getConditionalDominatorIds,
  getError,
  getEdgeByNameAndType,
  getLastNodeId,
  getLeakedNode,
  getNodesIdSet,
  getNumberNodeValue,
  getReadableBytes,
  getReadablePercent,
  getReadableTime,
  getRetainedSize,
  getRunMetaFilePath,
  getScenarioName,
  getSingleSnapshotFileForAnalysis,
  getSnapshotDirForAnalysis,
  getSnapshotFilesInDir,
  getSnapshotFilesFromTabsOrder,
  getSnapshotFromFile,
  getSnapshotNodeIdsFromFile,
  getSnapshotSequenceFilePath,
  getSnapshotFilePath,
  getSnapshotFilePathWithTabType,
  getStringNodeValue,
  getToNodeByEdge,
  getUniqueID,
  getWeakMapEdgeKeyId,
  haltOrThrow,
  hasHostRoot,
  hasOnlyWeakReferrers,
  hasReactEdges,
  isAlternateNode,
  isBlinkRootNode,
  isDebuggableNode,
  isDetachedFiberNode,
  isDetachedDOMNode,
  isDirectPropEdge,
  isDocumentDOMTreesRoot,
  isDOMNodeIncomplete,
  isEssentialEdge,
  isFiberNode,
  isFiberNodeDeletionsEdge,
  isHermesInternalObject,
  isHostRoot,
  isInterestingPath,
  isMeaningfulEdge,
  isMeaningfulNode,
  isNodeDominatedByDeletionsArray,
  isObjectNode,
  isPendingActivityNode,
  isPlainJSObjectNode,
  isReactFiberEdge,
  isReactPropsEdge,
  isRegularFiberNode,
  isReturnEdge,
  isRootNode,
  isSlicedStringNode,
  isStackTraceFrame,
  isStringNode,
  isURLEqual,
  isWeakMapEdge,
  isWeakMapEdgeToKey,
  isWeakMapEdgeToValue,
  iterateChildFiberNodes,
  iterateDescendantFiberNodes,
  loadRunMetaInfo,
  loadLeakFilter,
  loadScenario,
  loadTabsOrder,
  loadTargetInfoFromRunMeta,
  markAllDetachedFiberNode,
  markAlternateFiberNode,
  memCache,
  normalizeBaseUrl,
  pathHasDetachedHTMLNode,
  pathHasEdgeWithIndex,
  repeat,
  resolveFilePath,
  resolveSnapshotFilePath,
  runShell,
  setIsAlternateNode,
  setIsRegularFiberNode,
  shouldShowMoreInfo,
  shuffleArray,
  throwError,
  upperCaseFirstCharacter,
  getBooleanNodeValue,
};
