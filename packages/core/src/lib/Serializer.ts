/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import fs from 'fs';
import chalk from 'chalk';
import config from './Config';
import utils from './Utils';
import info from './Console';
import PathFinder from '../paths/TraceFinder';
import {
  E2EStepInfo,
  HeapNodeIdSet,
  IHeapEdge,
  IHeapNode,
  IHeapSnapshot,
  ISerializedInfo,
  LeakTracePathItem,
  Nullable,
  Optional,
} from './Types';

const REGEXP_NAME_CLEANUP = /[[]\(\)]/g;

type JSONifyOptions = {
  fiberNodeReturnTrace: Record<number, string>;
  forceJSONifyDepth?: number;
};

const EMPTY_JSONIFY_OPTIONS = {
  fiberNodeReturnTrace: {},
};

type JSONifyArgs = {
  leakedIdSet?: Set<number>;
  nodeIdsInSnapshots?: Array<Set<number>>;
};

function JSONifyNodeRetainSize(node: IHeapNode): string {
  const nodeRetainSize = node.retainedSize;
  return nodeRetainSize ? `$retained-size:${nodeRetainSize}` : '';
}

function getNodeNameInJSON(node: IHeapNode, args: JSONifyArgs = {}): string {
  const leakedIdSet = args.leakedIdSet;
  const isLeaked = leakedIdSet ? leakedIdSet.has(node.id) : false;
  let name = node.name === '' ? '<anonymous>' : node.name;

  const nodeImpact = JSONifyNodeRetainSize(node);

  if (utils.isFiberNode(node)) {
    name = utils.extractFiberNodeInfo(node);
  } else if (node.type === 'closure') {
    name = utils.extractClosureNodeInfo(node);
  }

  // replace all [, ], (, and )
  name = name.replace(REGEXP_NAME_CLEANUP, ' ');

  const leakTag = isLeaked ? '$memLabTag:leaked' : '';

  // figure out the node is allocated in which snapshot
  let snapshotTag = '';
  if (args.nodeIdsInSnapshots) {
    for (let i = 0; i < args.nodeIdsInSnapshots.length; i++) {
      const snapshotIds = args.nodeIdsInSnapshots[i];
      if (snapshotIds.has(node.id)) {
        snapshotTag = `$snapshotIdTag:${i + 1}`;
        break;
      }
    }
  }

  const highlightTag = node.highlight ? '$highlight' : '';
  const alternateTag = utils.isAlternateNode(node)
    ? '$memLabTag:alternate'
    : '';

  if (name === 'system / Context') {
    name = '<function scope>';
  }
  let ret = `[${name}](${node.type})`;
  ret += ` @${node.id}`;
  ret += ` ${nodeImpact}`;
  ret += ` ${leakTag}`;
  ret += ` ${alternateTag}`;
  ret += ` ${snapshotTag}`;
  ret += ` ${highlightTag}`;
  return ret;
}

function getEdgeNameInJSON(edge: IHeapEdge, edgeRetainSize = 0): string {
  const prefix = `  --${JSONifyEdgeNameAndType(edge)}`;
  const suffix = '--->  ';
  const sizeInfo =
    edgeRetainSize > 0 ? `(retaining bytes: ${edgeRetainSize})` : '';
  return `${prefix}${sizeInfo}${suffix}`;
}

function JSONifyEdgeNameAndType(edge: IHeapEdge): string {
  const edgeName = filterJSONPropName(edge.name_or_index);
  const edgeType = edge.type === 'context' ? 'variable' : edge.type;
  return `${edgeName} (${edgeType})`;
}

function filterJSONPropName(name_or_index: string | number): string | number {
  if (name_or_index === 'hasOwnProperty') {
    name_or_index += ' ';
  }
  if (typeof name_or_index === 'string') {
    // replace all [, ], (, and )
    name_or_index = name_or_index.replace(/[[\]()]/g, '');
  }
  return name_or_index;
}

function JSONifyDetachedHTMLElement(
  node: IHeapNode,
  args: JSONifyArgs,
  options: JSONifyOptions,
): ISerializedInfo {
  const info = Object.create(null);

  // options for elem.__reactFiber$xxx
  const fiberOptions = {...options};
  const nextDepth = options.forceJSONifyDepth
    ? options.forceJSONifyDepth - 1
    : undefined;
  fiberOptions.forceJSONifyDepth = nextDepth;

  // options for elem.__reactProps$xxx
  const propsOptions = {...options};
  propsOptions.forceJSONifyDepth = 1;

  for (const edge of node.references) {
    const key = JSONifyEdgeNameAndType(edge);
    if (utils.isReactFiberEdge(edge)) {
      info[key] = JSONifyNode(edge.toNode, args, fiberOptions);
    } else if (utils.isReactPropsEdge(edge)) {
      info[key] = JSONifyNode(edge.toNode, args, propsOptions);
    } else {
      info[key] = JSONifyNodeInShort(edge.toNode);
    }
  }
  return info;
}

function calculateReturnTrace(
  node: Nullable<IHeapNode>,
  cache: Record<number, string>,
): Nullable<string> {
  if (!node || !utils.isFiberNode(node)) {
    return null;
  }
  if (cache[node.nodeIndex]) {
    return cache[node.nodeIndex];
  }

  const returnNode = utils.getToNodeByEdge(node, 'return', 'property');
  const returnNodeTrace = calculateReturnTrace(returnNode, cache);
  return (cache[node.nodeIndex] = node.nodeIndex + ' | ' + returnNodeTrace);
}

// use properties that should be serialized with more in-depth info
const objectNodeUsefulProps: Set<string | number> = new Set(['_context']);

function JSONifyNodeOneLevel(node: IHeapNode): ISerializedInfo {
  const info = Object.create(null);
  for (const edge of node.references) {
    const key = JSONifyEdgeNameAndType(edge);
    info[key] = JSONifyNodeShallow(edge.toNode);
  }
  return info;
}

function JSONifyNodeShallow(node: IHeapNode): ISerializedInfo {
  const info = Object.create(null);
  for (const edge of node.references) {
    const key = JSONifyEdgeNameAndType(edge);
    if (objectNodeUsefulProps.has(edge.name_or_index)) {
      info[key] = JSONifyNodeShallow(edge.toNode);
    } else {
      info[key] = JSONifyNodeInShort(edge.toNode);
    }
  }
  return info;
}

const fiberNodeUsefulProps: Set<string | number> = new Set([
  'stateNode',
  'type',
  'elementType',
]);

function JSONifyFiberNodeShallow(node: IHeapNode): ISerializedInfo {
  const info = Object.create(null);
  for (const edge of node.references) {
    const key = JSONifyEdgeNameAndType(edge);
    if (
      fiberNodeUsefulProps.has(edge.name_or_index) &&
      utils.isObjectNode(edge.toNode)
    ) {
      info[key] = JSONifyNodeShallow(edge.toNode);
      continue;
    }
    info[key] = JSONifyNodeInShort(edge.toNode);
  }
  return info;
}

// calculate the summary of return chain of the FiberNode
function JSONifyFiberNodeReturnTrace(
  node: IHeapNode,
  args: JSONifyArgs,
  options: JSONifyOptions,
): Nullable<string> {
  const cache = options.fiberNodeReturnTrace;
  const returnTrace = calculateReturnTrace(node, cache);
  if (!returnTrace) {
    return null;
  }
  const idxs = returnTrace.split(' | ');
  const trace = Object.create(null);
  let num = 0;
  for (const idx of idxs) {
    const index = Number(idx);
    let key = `${num++}`;
    if (Number.isNaN(index)) {
      continue;
    }
    const parent = node.snapshot.nodes.get(index);
    if (!parent) {
      continue;
    }
    const parentInfo = getNodeNameInJSON(parent, args);
    key = `${key}:  --return (property)--->  ${parentInfo}`;
    const info = JSONifyFiberNodeShallow(parent);
    trace[key] = info;
  }
  return trace;
}

function JSONifyFiberNode(
  node: IHeapNode,
  args: JSONifyArgs,
  options: JSONifyOptions,
): ISerializedInfo {
  const info = Object.create(null);

  // create an option to cache the FiberNode return chain
  if (!options.fiberNodeReturnTrace) {
    options.fiberNodeReturnTrace = Object.create(null);
  }

  const returnTraceJSON = JSONifyFiberNodeReturnTrace(node, args, options);
  info['React Fiber return chain (extra)'] = returnTraceJSON;

  const propsOptions = {...options};
  // for FiberNode, force expand a few more levels
  if (propsOptions.forceJSONifyDepth === undefined) {
    propsOptions.forceJSONifyDepth = 1;
  }
  propsOptions.forceJSONifyDepth--;

  for (const edge of node.references) {
    const key = JSONifyEdgeNameAndType(edge);
    info[key] =
      propsOptions.forceJSONifyDepth >= 1
        ? JSONifyNode(edge.toNode, args, propsOptions)
        : JSONifyNodeInShort(edge.toNode);
  }
  return info;
}

function JSONifyClosure(
  node: IHeapNode,
  args: JSONifyArgs,
  options: JSONifyOptions,
): ISerializedInfo {
  const info = Object.create(null);
  for (const edge of node.references) {
    if (
      edge.name_or_index === 'shared' ||
      edge.name_or_index === 'context' ||
      edge.name_or_index === 'displayName'
    ) {
      const key = filterJSONPropName(edge.name_or_index);
      info[key] = JSONifyNode(edge.toNode, args, options);
    }
  }
  return info;
}

function JSONifyNumberNode(
  node: IHeapNode,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _args: JSONifyArgs,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _options: JSONifyOptions,
): ISerializedInfo {
  const info = Object.create(null);
  info.value = utils.getNumberNodeValue(node);
  return info;
}

function JSONifyCode(
  node: IHeapNode,
  args: JSONifyArgs,
  options: JSONifyOptions,
): ISerializedInfo {
  const info = Object.create(null);
  for (const edge of node.references) {
    if (
      edge.name_or_index === 'name_or_scope_info' &&
      edge.toNode.name === '(function scope info)'
    ) {
      const key = 'variables with non-number values in closure scope chain';
      info[key] = JSONifyNode(edge.toNode, args, options);
    } else if (edge.name_or_index === 'script_or_debug_info') {
      info['script URL'] = edge.toNode.name;
    } else {
      const key = filterJSONPropName(edge.name_or_index);
      info[key] = JSONifyNode(edge.toNode, args, options);
    }
  }
  return info;
}

function JSONifyContext(
  node: IHeapNode,
  args: JSONifyArgs,
  options: JSONifyOptions,
): ISerializedInfo {
  const info = Object.create(null);
  const key = 'variables in scope (used by nested closures)';
  const closure_vars = (info[key] = Object.create(null));
  for (const edge of node.references) {
    const key = filterJSONPropName(edge.name_or_index);
    if (edge.type === 'context') {
      closure_vars[key] = JSONifyNodeInShort(edge.toNode);
    } else if (edge.type === '') {
      info[key] = JSONifyNode(edge.toNode, args, options);
    }
  }
  return info;
}

function JSONifyOrdinaryValue(
  node: IHeapNode,
  args: JSONifyArgs,
  options: JSONifyOptions,
): ISerializedInfo {
  const info = Object.create(null);
  for (const edge of node.references) {
    if (edge.name_or_index === 'map' && edge.type === 'internal') {
      continue;
    }
    const key = JSONifyEdgeNameAndType(edge);
    const toNode = edge.toNode;
    const toNodeName = toNode.name;
    const edgeName = edge.name_or_index;
    if (
      edgeName === 'function_data' ||
      edgeName === 'name_or_scope_info' ||
      toNode.type === 'concatenated string' ||
      (toNode.type === 'array' && toNode.edge_count < 200) ||
      toNodeName === 'system / SourcePositionTableWithFrameCache' ||
      toNodeName === 'system / StackTraceFrame' ||
      toNodeName === 'system / StackFrameInfo' ||
      edgeName === 'line_ends' ||
      (edgeName === 'properties' && edge.type === 'internal')
    ) {
      info[key] = JSONifyNode(toNode, args, options);
    } else {
      info[key] = JSONifyNodeInShort(toNode);
    }
  }
  return info;
}

function JSONifyNode(
  node: IHeapNode,
  args: JSONifyArgs,
  options: JSONifyOptions,
): ISerializedInfo {
  if (!node) {
    return {};
  }
  let info: ISerializedInfo;
  const depths = options.forceJSONifyDepth;
  if (utils.isDetachedDOMNode(node) && depths !== 0) {
    info = JSONifyDetachedHTMLElement(node, args, EMPTY_JSONIFY_OPTIONS);
  } else if (utils.isFiberNode(node) && depths !== 0) {
    info = JSONifyFiberNode(node, args, options);
  } else if (utils.shouldShowMoreInfo(node)) {
    info = JSONifyNodeOneLevel(node);
  } else if (node.type === 'closure') {
    info = JSONifyClosure(node, args, options);
  } else if (node.type === 'code') {
    info = JSONifyCode(node, args, options);
  } else if (node.name === 'system / Context') {
    info = JSONifyContext(node, args, options);
  } else if (node.type === 'number') {
    info = JSONifyNumberNode(node, args, options);
  } else {
    info = JSONifyOrdinaryValue(node, args, options);
  }

  if (node.location) {
    info[`${filterJSONPropName('allocation location (extra)')}`] = {
      script_id: node.location.script_id,
      line: node.location.line,
      column: node.location.column,
    };
  }

  if (node.dominatorNode) {
    info['dominator id (extra)'] = `@${node.dominatorNode.id}`;
  }
  return info;
}

function JSONifyTabsOrder(): string {
  const file = utils.getSnapshotSequenceFilePath();
  return fs.readFileSync(file, 'UTF-8');
}

function shouldHighlight(node: IHeapNode): boolean {
  return utils.isDetachedDOMNode(node) || utils.isDetachedFiberNode(node);
}

function JSONifyPath(
  path: LeakTracePathItem,
  _snapshot: IHeapSnapshot,
  args: JSONifyArgs,
): Nullable<ISerializedInfo> {
  if (!path.node) {
    return null;
  }

  const ret = Object.create(null);
  let idx = 0;
  let encounterDetachedNode = false;
  ret['$tabsOrder:' + JSONifyTabsOrder()] = '';
  ret[`${idx++}: ${getNodeNameInJSON(path.node, args)}`] = JSONifyNode(
    path.node,
    args,
    EMPTY_JSONIFY_OPTIONS,
  );
  let pathItem: Optional<LeakTracePathItem> = path;

  while (pathItem?.edge) {
    const edge = pathItem.edge;
    const nextNode = edge.toNode;
    if (!encounterDetachedNode && shouldHighlight(nextNode)) {
      encounterDetachedNode = true;
      nextNode.highlight = true;
    }
    const edgeRetainSize = pathItem.edgeRetainSize;
    ret[
      `${idx++}: ${getEdgeNameInJSON(edge, edgeRetainSize)}${getNodeNameInJSON(
        nextNode,
        args,
      )}`
    ] = JSONifyNode(nextNode, args, EMPTY_JSONIFY_OPTIONS);
    pathItem = pathItem.next;
  }

  return ret;
}

function JSONifyNodeInShort(node: IHeapNode): ISerializedInfo {
  const wrapper = {
    _isMemLabWrapper: true,
    tags: {
      retainedSize: node.retainedSize,
      id: node.id,
      type: node.type,
    },
    value: getNodeValue(node),
  };

  return wrapper;
}

function getNodeValue(node: IHeapNode): string | number {
  if (node.type === 'number') {
    return utils.getNumberNodeValue(node) ?? '[<empty number>]';
  }
  if (utils.isStringNode(node)) {
    const str = utils.getStringNodeValue(node);
    if (str !== '') {
      return `"${str}"`;
    } else {
      return '[<empty string>]';
    }
  }
  if (node.name === 'symbol') {
    const nameNode = utils.getToNodeByEdge(node, 'name');
    if (nameNode) {
      return `Symbol(${getNodeTypeShortName(nameNode)})`;
    }
  }
  const id = `@${node.id}`;
  if (utils.isFiberNode(node)) {
    return `[${utils.extractFiberNodeInfo(node)}] ${id}`;
  }
  if (node.name === 'system / Context') {
    return `[<function scope>] ${id}`;
  }

  if (node.name === 'system / Oddball') {
    let v = node.references[1].toNode.name;
    if (v === 'hole') {
      return 'undefined';
    }
    try {
      v = eval(v);
    } catch {
      if (config.verbose) {
        info.error(`unknown Oddball: ${v}`);
      }
      return '<unknown Oddball>';
    }
    return v + '';
  }

  if (node.name === 'symbol') {
    const nameNode = utils.getToNodeByEdge(node, 'name');
    if (nameNode) {
      return `Symbol(${getNodeValue(nameNode)})`;
    }
  }

  if (utils.isFiberNode(node)) {
    return `[${utils.extractFiberNodeInfo(node)}]`;
  }
  if (node.name === 'system / Context') {
    return `[<function scope>]`;
  }
  if (node.name === '') {
    return `[<${node.type}>]`;
  }
  return `[${node.name}]`;
}

function getNodeTypeShortName(node: IHeapNode): string {
  const value = getNodeValue(node);

  if (
    node.type === 'number' ||
    node.name === 'system / Oddball' ||
    node.name === 'symbol' ||
    node.type === 'concatenated string' ||
    node.type === 'string'
  ) {
    return value + '';
  }

  const id = `@${node.id}`;
  return `${value} ${id}`;
}

function stringifyNode(node: IHeapNode, str: string): string {
  if (
    !node ||
    node.type === 'code' ||
    node.type === 'hidden' ||
    node.type === 'array' ||
    node.type === 'native' ||
    node.type === 'closure'
  ) {
    return str;
  }

  let info: ISerializedInfo;
  if (node.name === 'system / Context') {
    info = {closure_vars: Object.create(null)};
    for (const edge of node.references) {
      if (edge.type === 'context') {
        const key = filterJSONPropName(edge.name_or_index);
        (info.closure_vars as Record<string, ISerializedInfo>)[key] =
          JSONifyNodeInShort(edge.toNode);
      }
    }
  } else {
    info = Object.create(null);
    for (const edge of node.references) {
      const key = filterJSONPropName(edge.name_or_index);
      if (edge.type === 'property') {
        info[key] = JSONifyNodeInShort(edge.toNode);
      }
    }
  }
  const nodeJSON = JSON.stringify(info, null, 2);
  str += beautifyJSON(nodeJSON);
  str += '\n';
  return str;
}

function beautifyJSON(nodeJSON: string): string {
  const indent = '    ';
  return nodeJSON
    .split('\n')
    .map(l => {
      // add indentation to each line
      l = indent + l;
      return l;
    })
    .join('\n');
}

type SummarizeOptions = {
  compact?: boolean;
  color?: boolean;
  progress?: number;
  abstract?: boolean;
  depth?: number;
  excludeKeySet?: HeapNodeIdSet;
};

function summarizeObjectShape(
  node: IHeapNode,
  options: SummarizeOptions = {},
): string {
  const refs = node.references;
  const props = [];
  for (const edge of refs) {
    const name = edge.name_or_index;
    if (edge.type === 'internal') {
      continue;
    }
    if (!config.edgeIgnoreSetInShape.has(name)) {
      props.push(name);
    }
  }
  let keys = options.compact ? props.slice(0, 5) : props;
  keys = keys.sort();
  keys = options.color ? keys.map(k => chalk.green(k)) : keys;
  keys = keys.length < props.length ? keys.concat('...') : keys;

  const sep = options.color ? chalk.grey(', ') : ', ';
  const beg = options.color ? chalk.bold('{ ') : '{ ';
  const end = options.color ? chalk.bold(' }') : ' }';
  return `Object ${beg}${keys.join(sep)}${end}`;
}

// convert a heap object into a string showing its shape
function summarizeNodeShape(
  node: IHeapNode,
  options: SummarizeOptions = {},
): string {
  if (utils.isStringNode(node)) {
    return options.color ? chalk.blue.bold('string') : 'string';
  }
  if (!utils.isPlainJSObjectNode(node)) {
    const name = node.name;
    return options.color ? chalk.blue.bold(name) : name;
  }
  return summarizeObjectShape(node, options);
}

type UnboundedObjectInfo = {
  id: number;
  name: string;
  node: IHeapNode;
  type: string;
  history: number[];
};

function summarizeUnboundedObjects(
  unboundedObjects: UnboundedObjectInfo[],
  options: SummarizeOptions = {},
): string {
  const sizeSep = options.color ? chalk.grey(' > ') : ' > ';
  const prefix = options.color ? chalk.grey('· ') : '· ';
  const opt = {compact: true, ...options};
  return unboundedObjects
    .map(item => {
      const id = options.color ? chalk.grey(`@${item.id}`) : `@${item.id}`;
      const name = summarizeNodeShape(item.node, opt);
      return (
        `${prefix}${name} [${item.type}](${id}):  ` +
        item.history.map(v => utils.getReadableBytes(v)).join(sizeSep)
      );
    })
    .join('\n');
}

function summarizeUnboundedObjectsToCSV(
  unboundedObjects: UnboundedObjectInfo[],
): string {
  return unboundedObjects
    .map(item => {
      return `${item.name},${item.id},${item.type},` + item.history.join(',');
    })
    .join('\n');
}

function summarizeTab(tab: E2EStepInfo, color = false): string {
  let res = tab.name;
  if (tab.JSHeapUsedSize) {
    const bytes = utils.getReadableBytes(tab.JSHeapUsedSize);
    res += color ? `[${chalk.green(bytes)}]` : ` [${bytes}]`;
  }
  if (tab.type) {
    res += color ? `(${chalk.green(tab.type)})` : ` (${tab.type})`;
  }
  if (tab.snapshot) {
    res += color ? `[${chalk.green('s' + tab.idx)}]` : ` [s${tab.idx}]`;
  }
  return res;
}

function summarizeTabsOrder(
  tabsOrder: E2EStepInfo[],
  options: SummarizeOptions = {},
): string {
  const tabSep = options.color ? chalk.grey('>') : '>';
  let res = '';
  for (let i = 0; i < tabsOrder.length; ++i) {
    const tab = tabsOrder[i];
    const sep = i < tabsOrder.length - 1 ? tabSep : '';
    const isCurrentTab = i === options.progress;
    let tabSummaryString = summarizeTab(tab, options.color);
    if (options.color && isCurrentTab) {
      tabSummaryString = chalk.bold(tabSummaryString);
    }
    const tabSummaryStringWithSeparator = `${tabSummaryString} ${sep} `;
    if (
      options.color &&
      options.progress !== undefined &&
      i > options.progress
    ) {
      res += chalk.dim(tabSummaryStringWithSeparator);
    } else {
      res += tabSummaryStringWithSeparator;
    }
  }
  return res;
}

function summarizeNodeName(node: IHeapNode, options: SummarizeOptions): string {
  const name = getNodeTypeShortName(node);
  const nodeStr = name.split('@')[0].trim();
  return options.color ? chalk.green(nodeStr) : nodeStr;
}

function summarizeNode(
  node: IHeapNode,
  options: SummarizeOptions = {},
): string {
  const nodeRetainSize = utils.getReadableBytes(node.retainedSize);
  let nodeImpact = '';
  if (nodeRetainSize) {
    nodeImpact = options.color
      ? chalk.grey('[') + chalk.blue.bold(nodeRetainSize) + chalk.grey(']')
      : `[${nodeRetainSize}]`;
  }

  const name = summarizeNodeName(node, options);
  const type = options.color ? chalk.grey(`(${node.type})`) : `(${node.type})`;
  const id = options.color ? chalk.grey(`@${node.id}`) : `@${node.id}`;
  return `${name} ${type} ${id} ${nodeImpact}`;
}

function summarizeEdgeName(
  edge: IHeapEdge,
  options: SummarizeOptions = {},
): string {
  let name = `${edge.name_or_index}`;
  if (options.abstract) {
    if (edge.is_index) {
      name = '<numeric-element>';
    }
    if (
      edge.fromNode.type === 'array' &&
      edge.type === 'internal' &&
      !isNaN(parseInt(name, 10))
    ) {
      name = '<array-element>';
    }
  }
  return options.color ? chalk.white(name) : name;
}

function summarizeEdge(
  edge: IHeapEdge,
  edgeRetainSize: number,
  options: SummarizeOptions = {},
): string {
  const edgeImpact = edgeRetainSize
    ? `[${utils.getReadableBytes(edgeRetainSize)}]`
    : '';
  const edgeType = edge.type === 'context' ? 'variable' : edge.type;
  const beg = options.color ? chalk.grey('--') : '--';
  const end = (options.color ? chalk.grey('---') : '---') + '>';
  const type = options.color ? chalk.grey(`(${edgeType})`) : `(${edgeType})`;
  const name = summarizeEdgeName(edge, options);
  return `  ${beg}${name} ${type}${edgeImpact}${end}  `;
}

function summarizePath(
  pathArg: LeakTracePathItem,
  nodeIdInPaths: Set<number>,
  snapshot: IHeapSnapshot,
  options: SummarizeOptions = {},
): string {
  const depth = options.depth ?? 0;
  if (depth > 5) {
    return '...';
  }
  const excludeKeySet = options.excludeKeySet || new Set();
  let ret = '';
  let p: Optional<LeakTracePathItem> = pathArg;
  let hasWeakMapEdge = false;
  let weakMapKeyObjectId = undefined;
  let weakMapEdgeIdx = undefined;

  while (p) {
    const node = p.node;
    const edge = p.edge;
    if (node) {
      nodeIdInPaths.add(node.id);
      ret += `${summarizeNode(node, options)}\n`;
      // if we need to further expand node properties in the summary
      if (config.dumpNodeInfo) {
        ret += stringifyNode(node, ret);
      }
    }

    if (edge) {
      if (utils.isWeakMapEdgeToValue(edge)) {
        hasWeakMapEdge = true;
        weakMapEdgeIdx = edge.edgeIndex;
        weakMapKeyObjectId = utils.getWeakMapEdgeKeyId(edge);
      }
      ret += edge ? summarizeEdge(edge, p.edgeRetainSize ?? 0, options) : '';
    }

    p = p.next;
  }
  if (!config.chaseWeakMapEdge || !hasWeakMapEdge || depth >= 1000) {
    return ret;
  }

  info.midLevel(`depth: ${depth}`);
  // recursively dump the path for the key
  // but first make sure we do not dump the same WeakMap edge again
  if (weakMapKeyObjectId) {
    const keyNode = snapshot.getNodeById(weakMapKeyObjectId);
    excludeKeySet.add(weakMapKeyObjectId);

    const finder = new PathFinder();
    let keyNodePath = finder.getPathToGCRoots(snapshot, keyNode);
    if (!keyNodePath) {
      return ret;
    }

    // if the shortest path contains the same WeakMap edge,
    // we need to exclude the edge and re-search the shortest path
    if (
      weakMapEdgeIdx !== undefined &&
      utils.pathHasEdgeWithIndex(keyNodePath, weakMapEdgeIdx)
    ) {
      finder.annotateShortestPaths(snapshot, excludeKeySet);
      keyNodePath = finder.getPathToGCRoots(snapshot, keyNode);
      if (!keyNodePath) {
        return ret;
      }
    }

    const subPathSummary = summarizePath(keyNodePath, nodeIdInPaths, snapshot, {
      ...options,
      depth: depth + 1,
    });
    const sep = '------';
    ret += `\n${sep} WeakMap key node path (depth: ${depth}) ${sep}\n`;
    ret += subPathSummary;
  }

  return ret;
}

export default {
  JSONifyPath,
  summarizeEdgeName,
  summarizeNodeName,
  summarizeNodeShape,
  summarizePath,
  summarizeTabsOrder,
  summarizeUnboundedObjects,
  summarizeUnboundedObjectsToCSV,
};
