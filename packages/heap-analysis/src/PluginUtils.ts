/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import {
  IHeapSnapshot,
  IHeapNode,
  AnyOptions,
  IHeapEdge,
  Nullable,
  Optional,
  MemLabConfig,
  config,
} from '@memlab/core';

import chalk from 'chalk';
import {info, analysis, serializer, utils} from '@memlab/core';

export type HeapAnalysisOptions = {
  args: ParsedArgs;
  config?: MemLabConfig;
};

const nodeNameBlockList = new Set([
  '(Startup object cache)',
  '(Global handles)',
  '(External strings)',
  '(Builtins)',
]);

const nodeTypeBlockList = new Set([
  'array',
  'native',
  'code',
  'synthetic',
  'hidden',
]);

const defaultAnalysisArgs = {args: {_: []}};

function isNodeWorthInspecting(node: IHeapNode): boolean {
  // exclude meta objects like GC roots etc.
  if (node.id <= 3) {
    return false;
  }
  if (nodeTypeBlockList.has(node.type)) {
    return false;
  }
  if (nodeNameBlockList.has(node.name)) {
    return false;
  }
  return true;
}

// filter out dominators that have a similar size
// for example if input is [A, B] and A is the dominator of B
// then this function throw away A if the size of A is close to the size of B
function filterOutDominators(nodeList: IHeapNode[]): IHeapNode[] {
  const candidateIdSet = new Set(nodeList.map(node => node.id));
  const childrenSizeInList = new Map();

  for (const node of nodeList) {
    const visitedIds = new Set();
    let curNode: Nullable<IHeapNode> = node;

    inner: while (!visitedIds.has(curNode.id)) {
      curNode = node.dominatorNode;
      if (!curNode || curNode.id === node.id) {
        break inner;
      }
      // record the size of the children node in the candidate list
      // and associate the children size with its dominator in the candidate list
      if (candidateIdSet.has(curNode.id)) {
        let childrenSize = node.retainedSize;
        if (childrenSizeInList.has(curNode.id)) {
          childrenSize += childrenSizeInList.get(curNode.id)[1];
        }
        childrenSizeInList.set(curNode.id, [
          curNode.retainedSize,
          childrenSize,
        ]);
        break inner;
      }
      visitedIds.add(curNode.id);
    }
  }

  // remove the dominator node from the candidate set
  // if the dominator node's size is similar to the child node
  for (const [
    dominatorId,
    [dominatorSize, childrenSize],
  ] of childrenSizeInList) {
    if (dominatorSize - childrenSize < 500000) {
      candidateIdSet.delete(dominatorId);
    }
  }

  return nodeList.filter(node => candidateIdSet.has(node.id));
}

type PrintNodeOption = {
  indent?: string;
  printReferences?: boolean;
};
function printNodeListInTerminal(
  nodeList: IHeapNode[],
  options: AnyOptions & PrintNodeOption = {},
): void {
  const dot = chalk.grey('· ');
  const indent = options.indent || '';
  const printRef = !!options.printReferences;

  if (!options.printAll) {
    nodeList = filterOutDominators(nodeList);
  }

  for (const node of nodeList) {
    const nodeInfo = getHeapObjectString(node);
    info.topLevel(`${indent}${dot}${nodeInfo}`);
    if (printRef) {
      printReferencesInTerminal(node.references, {indent: indent + '  '});
    }
  }
}

function isNumeric(v: number | string): boolean {
  if (typeof v === 'number') {
    return true;
  }
  if (parseInt(v, 10) + '' === v + '') {
    return true;
  }
  if (parseFloat(v) + '' === v + '') {
    return true;
  }
  return false;
}

function getObjectReferenceNames(node: IHeapNode): string {
  const referrers = node.referrers;
  const names = new Set();
  const visited = new Set();

  for (const edge of referrers) {
    const name = edge.name_or_index;

    // in case infinite loop
    if (visited.has(edge.edgeIndex)) {
      continue;
    }
    visited.add(edge.edgeIndex);

    // numeric index is not informative
    if (isNumeric(name) || name === '') {
      continue;
    }

    // context and previous references are not informative
    if (
      (name === 'previous' || name === 'context') &&
      edge.type === 'internal'
    ) {
      for (const ref of edge.fromNode.referrers) {
        referrers.push(ref);
      }
      continue;
    }

    names.add(name);
  }
  const refs = Array.from(names).slice(0, 10).join(chalk.grey(', '));
  return 'refs: ' + chalk.grey('[') + refs + chalk.grey(']');
}

function getHeapObjectString(node: IHeapNode): string {
  const colon = chalk.grey(':');
  const comma = chalk.grey(',');
  const serializeOpt = {color: true, compact: true};
  const shapeStr = serializer.summarizeNodeShape(node, serializeOpt);
  const edgeCount = getObjectOutgoingEdgeCount(node);
  const fanout = `${edgeCount} edges`;
  const bytes = utils.getReadableBytes(node.retainedSize);
  const nodeId = chalk.grey(`@${node.id}`);
  const type = node.type === 'object' ? '' : ` ${node.type}`;
  const refs = getObjectReferenceNames(node);

  return (
    `${nodeId}${type} ${shapeStr}${colon} ` +
    `${fanout}${comma} ${bytes}${comma} ${refs}`
  );
}

function getReferenceString(edge: IHeapEdge): string {
  const edgeName = chalk.green(edge.name_or_index);
  const objectInfo = getHeapObjectString(edge.toNode);

  return ` --${edgeName}--> ${objectInfo}`;
}

function printReferencesInTerminal(
  edgeList: IHeapEdge[],
  options: AnyOptions & PrintNodeOption = {},
): void {
  const dot = chalk.grey('· ');
  const indent = options.indent || '';
  for (const edge of edgeList) {
    const refStr = getReferenceString(edge);
    info.topLevel(`${indent}${dot}${refStr}`);
  }
}

function getObjectOutgoingEdgeCount(node: IHeapNode): number {
  if (node.name === 'Set' || node.name === 'Map') {
    const edge = utils.getEdgeByNameAndType(node, 'table');
    if (!edge) {
      return node.edge_count;
    }
    return edge.toNode.edge_count;
  }
  return node.edge_count;
}

function getSnapshotFileForAnalysis(options: HeapAnalysisOptions): string {
  const args = options.args;
  if (args.snapshot) {
    return args.snapshot;
  }
  if (config.externalSnapshotFilePaths.length > 0) {
    return config.externalSnapshotFilePaths[
      config.externalSnapshotFilePaths.length - 1
    ];
  }
  return utils.getSingleSnapshotFileForAnalysis();
}

function getSnapshotDirForAnalysis(
  options: HeapAnalysisOptions,
): Nullable<string> {
  const args = options.args;
  if (args['snapshot-dir']) {
    return args['snapshot-dir'];
  }
  if (config.externalSnapshotDir) {
    return config.externalSnapshotDir;
  }
  return null;
}

async function loadHeapSnapshot(
  options: HeapAnalysisOptions,
): Promise<IHeapSnapshot> {
  const file = getSnapshotFileForAnalysis(options);
  return loadProcessedSnapshot({file});
}

async function loadProcessedSnapshot(
  options: AnyOptions & {file?: Optional<string>} = {},
): Promise<IHeapSnapshot> {
  const opt = {buildNodeIdIndex: true, verbose: true};
  const file = options.file || utils.getSnapshotFilePathWithTabType(/.*/);
  const snapshot = await utils.getSnapshotFromFile(file as string, opt);
  analysis.preparePathFinder(snapshot);
  return snapshot;
}

async function snapshotMapReduce<T1, T2>(
  mapCallback: (snapshot: IHeapSnapshot, i: number, file: string) => T1,
  reduceCallback: (results: T1[]) => T2,
  options: HeapAnalysisOptions,
): Promise<T2> {
  const snapshotDir = getSnapshotDirForAnalysis(options);
  utils.checkSnapshots({snapshotDir});
  const snapshotFiles = snapshotDir
    ? // load snapshots from a directory
      utils.getSnapshotFilesInDir(snapshotDir)
    : // load snapshots based on the visit sequence meta data
      utils.getSnapshotFilesFromTabsOrder();

  const intermediateResults = [];
  for (let i = 0; i < snapshotFiles.length; ++i) {
    const file = snapshotFiles[i];
    // force GC before loading each snapshot
    if (global.gc) {
      global.gc();
    }
    const snapshot = await loadProcessedSnapshot({file});
    intermediateResults.push(mapCallback(snapshot, i, file));
  }

  return reduceCallback(intermediateResults);
}

function aggregateDominatorMetrics(
  ids: Set<number>,
  snapshot: IHeapSnapshot,
  checkNodeCb: (node: IHeapNode) => boolean,
  nodeMetricsCb: (node: IHeapNode) => number,
): number {
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

function filterOutLargestObjects(
  snapshot: IHeapSnapshot,
  objectFilter: (node: IHeapNode) => boolean,
  listSize = 50,
): IHeapNode[] {
  let largeObjects: IHeapNode[] = [];
  snapshot.nodes.forEach(node => {
    if (!objectFilter(node)) {
      return;
    }
    const size = node.retainedSize;
    let i: number;
    for (i = largeObjects.length - 1; i >= 0; --i) {
      if (largeObjects[i].retainedSize >= size) {
        largeObjects.splice(i + 1, 0, node);
        break;
      }
    }
    if (i < 0) {
      largeObjects.unshift(node);
    }
    largeObjects = largeObjects.slice(0, listSize);
  });
  return largeObjects;
}

export default {
  aggregateDominatorMetrics,
  defaultAnalysisArgs,
  filterOutLargestObjects,
  getObjectOutgoingEdgeCount,
  getSnapshotDirForAnalysis,
  getSnapshotFileForAnalysis,
  isNodeWorthInspecting,
  loadHeapSnapshot,
  printNodeListInTerminal,
  printReferencesInTerminal,
  snapshotMapReduce,
};
