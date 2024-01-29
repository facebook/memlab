/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {
  AnyOptions,
  HeapNodeIdSet,
  IHeapEdge,
  IHeapEdges,
  IHeapNode,
  IHeapNodes,
  IHeapSnapshot,
  LeakTracePathItem,
  Nullable,
  Optional,
  Predicator,
} from '../lib/Types';

import config from '../lib/Config';
import info from '../lib/Console';
import utils from '../lib/Utils';

const ROOT_NODE_INDEX = 0;
const PAGE_OBJECT_FLAG = 1;

type PostOrderMapping = {
  postOrderIndex2NodeIndex: Uint32Array;
  nodeIndex2PostOrderIndex: Uint32Array;
};

class TraceFinder {
  getRootNodeList(
    snapshot: IHeapSnapshot,
    opt: {prioritize?: boolean} = {},
  ): [IHeapNode[], IHeapNode[]] {
    const highPri: IHeapNode[] = [];
    const lowPri: IHeapNode[] = [];
    if (opt.prioritize) {
      snapshot.nodes.forEach(node => {
        if (
          utils.isRootNode(node, {
            excludeBlinkRoot: true,
            excludePendingActivity: true,
          })
        ) {
          highPri.push(node);
        } else if (utils.isRootNode(node)) {
          lowPri.push(node);
        }
      });
    } else {
      snapshot.nodes.forEach(node => {
        if (utils.isRootNode(node)) {
          highPri.push(node);
        }
      });
    }
    return [highPri, lowPri];
  }

  visitReachableNodesbyDFS(
    snapshot: IHeapSnapshot,
    nodeVisitor?: Optional<Predicator<IHeapNode>>,
    edgeVisitor?: Optional<Predicator<IHeapEdge>>,
  ): void {
    const [queue] = this.getRootNodeList(snapshot);
    const queuedIDs = new Set(queue.map(n => n.id));
    const visitedIDs = new Set();
    const traverseOption = {
      visited: visitedIDs,
      queued: queuedIDs,
      excludeWeakMapEdge: false, // do not exclude all weak maps
      isForward: true,
    };
    while (queue.length > 0) {
      const node = queue.pop();
      if (!node || visitedIDs.has(node.id)) {
        continue;
      }
      if (nodeVisitor && nodeVisitor(node) === false) {
        continue;
      }
      visitedIDs.add(node.id);

      for (const edge of node.references) {
        if (!this.shouldTraverseEdge(edge, snapshot, traverseOption)) {
          continue;
        }

        const nextNode = edge.toNode;
        // deal with weak map specifically
        if (utils.isWeakMapEdgeToKey(edge)) {
          const weakMapKeyObjectId = utils.getWeakMapEdgeKeyId(edge);
          // in weak map keys are weakly referenced
          if (weakMapKeyObjectId === nextNode.id) {
            continue;
          }
        }

        if (edgeVisitor && edgeVisitor(edge) === false) {
          continue;
        }

        queue.push(nextNode);
        queuedIDs.add(nextNode.id);
      }
    }
  }

  flagReachableNodesFromWindow(
    snapshot: IHeapSnapshot,
    flags: Uint32Array,
    flag: number,
  ): void {
    const nodesCount = snapshot.nodes.length;
    const nodesToVisit = new Uint32Array(nodesCount);
    let nodesToVisitLength = 0;

    const node = snapshot.nodes.get(ROOT_NODE_INDEX) as IHeapNode;

    for (const edge of node.references) {
      const toNode = edge.toNode;
      const type = edge.type;
      if (type === 'element') {
        if (utils.isDocumentDOMTreesRoot(toNode)) {
          continue;
        }
      } else if (type === 'shortcut') {
        continue;
      }
      const childNodeIndex = toNode.nodeIndex;
      nodesToVisit[nodesToVisitLength++] = childNodeIndex;
      flags[childNodeIndex] |= flag;
    }

    // flag all heap objects reachable from the root
    while (nodesToVisitLength > 0) {
      const nodeIndex = nodesToVisit[--nodesToVisitLength];
      const node = snapshot.nodes.get(nodeIndex) as IHeapNode;

      for (const edge of node.references) {
        const childNode = edge.toNode;
        const childNodeIndex = childNode.nodeIndex;
        if (flags[childNodeIndex] & flag) {
          continue;
        }
        if (edge.type === 'weak') {
          continue;
        }
        nodesToVisit[nodesToVisitLength++] = childNodeIndex;
        flags[childNodeIndex] |= flag;
      }
    }
  }

  // build post order based on:
  //  Keith D. Cooper and Timothy J. Harvey and Ken Kennedy
  //  "A Simple, Fast Dominance Algorithm"
  private buildPostOrderIndex(
    snapshot: IHeapSnapshot,
    flags: Uint32Array,
  ): PostOrderMapping {
    const nodeCount = snapshot.nodes.length;
    const rootNodeIndex = ROOT_NODE_INDEX;

    const forwardEdges = snapshot.edges;
    const firstEdgeIndexes = new Uint32Array(nodeCount + 1);
    firstEdgeIndexes[nodeCount] = forwardEdges.length;
    for (let nodeIndex = 0, edgeIndex = 0; nodeIndex < nodeCount; ++nodeIndex) {
      firstEdgeIndexes[nodeIndex] = edgeIndex;
      edgeIndex += (snapshot.nodes.get(nodeIndex) as IHeapNode).edge_count;
    }

    const flag = PAGE_OBJECT_FLAG;
    const nodeStack = new Uint32Array(nodeCount);
    const edgeStack = new Uint32Array(nodeCount);
    const postOrderIndex2NodeIndex = new Uint32Array(nodeCount);
    const nodeIndex2PostOrderIndex = new Uint32Array(nodeCount);
    const visited = new Uint8Array(nodeCount);
    let postOrderIndex = 0;

    // build a DFS stack and put the root node
    // at the bottom of the stack
    let stackTopIndex = 0;
    nodeStack[0] = rootNodeIndex;
    edgeStack[0] = firstEdgeIndexes[rootNodeIndex];
    visited[rootNodeIndex] = 1;

    let iteratedOnce = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // use DFS to traverse all nodes via a stack
      while (stackTopIndex >= 0) {
        const nodeIndex = nodeStack[stackTopIndex];
        const edgeIndex = edgeStack[stackTopIndex];
        const edgesEnd = firstEdgeIndexes[nodeIndex + 1];

        if (edgeIndex < edgesEnd) {
          edgeStack[stackTopIndex]++;
          const edgeType = (forwardEdges.get(edgeIndex) as IHeapEdge).type;
          if (!utils.isEssentialEdge(nodeIndex, edgeType, rootNodeIndex)) {
            continue;
          }
          const childNodeIndex = (forwardEdges.get(edgeIndex) as IHeapEdge)
            .toNode.nodeIndex;
          if (visited[childNodeIndex]) {
            continue;
          }
          const nodeFlag = flags[nodeIndex] & flag;
          const childNodeFlag = flags[childNodeIndex] & flag;
          // According to Chrome devtools, need to skip the edges from
          // non-page-owned nodes to page-owned nodes (since debugger may
          // also have references to heap objects)
          if (nodeIndex !== rootNodeIndex && childNodeFlag && !nodeFlag) {
            continue;
          }
          ++stackTopIndex;
          nodeStack[stackTopIndex] = childNodeIndex;
          edgeStack[stackTopIndex] = firstEdgeIndexes[childNodeIndex];
          visited[childNodeIndex] = 1;
        } else {
          // DFS is done, now build the post order based on the stack
          nodeIndex2PostOrderIndex[nodeIndex] = postOrderIndex;
          postOrderIndex2NodeIndex[postOrderIndex++] = nodeIndex;
          --stackTopIndex;
        }
      }

      // If we have tried by build the stack once previously
      // or we have already built the post order for all nodes
      if (iteratedOnce || postOrderIndex === nodeCount) {
        break;
      }

      // Otherwise there are some nodes unreachable from
      // the root node
      if (config.verbose) {
        info.overwrite(
          `${nodeCount - postOrderIndex} nodes are unreachable from the root`,
        );
      }

      // Now the root node has the last post order index and
      // the DFS stack is empty; we need to put the root node
      // back to the bottom of the DFS stack, traverse all the
      // orphan nodes with weak referrers (nodes unreachable
      // from the root), and make sure the root node has the
      // last post order index
      --postOrderIndex;
      stackTopIndex = 0;
      nodeStack[0] = rootNodeIndex;
      // skip iterating the edges of the root node
      edgeStack[0] = firstEdgeIndexes[rootNodeIndex + 1];
      for (let nodeIndex = 0; nodeIndex < nodeCount; ++nodeIndex) {
        if (
          visited[nodeIndex] ||
          !utils.hasOnlyWeakReferrers(
            snapshot.nodes.get(nodeIndex) as IHeapNode,
          )
        ) {
          continue;
        }

        // Add all nodes that have only weak referrers
        // to traverse their subgraphs
        ++stackTopIndex;
        nodeStack[stackTopIndex] = nodeIndex;
        edgeStack[stackTopIndex] = firstEdgeIndexes[nodeIndex];
        visited[nodeIndex] = nodeIndex;
      }
      iteratedOnce = true;
    }

    // If we already processed all orphan nodes (nodes unreachable from root)
    // that have only weak referrers and still have some orphans
    if (postOrderIndex !== nodeCount) {
      if (config.verbose) {
        info.lowLevel(
          nodeCount - postOrderIndex + ' unreachable nodes in heap snapshot',
        );
      }

      // Now the root node has the last post order index and
      // the DFS stack is empty; we need to put the root node
      // back to the bottom of the DFS stack, traverse all the
      // remaining orphan nodes (nodes unreachable from the root),
      // and make sure the root node has the last post order index
      --postOrderIndex;
      for (let nodeIndex = 0; nodeIndex < nodeCount; ++nodeIndex) {
        if (visited[nodeIndex]) {
          continue;
        }
        // give the orphan node a postorder index anyway
        nodeIndex2PostOrderIndex[nodeIndex] = postOrderIndex;
        postOrderIndex2NodeIndex[postOrderIndex++] = nodeIndex;
      }
      nodeIndex2PostOrderIndex[rootNodeIndex] = postOrderIndex;
      postOrderIndex2NodeIndex[postOrderIndex++] = rootNodeIndex;
    }

    return {
      postOrderIndex2NodeIndex,
      nodeIndex2PostOrderIndex,
    };
  }

  // The dominance algorithm is from:
  //  Keith D. Cooper and Timothy J. Harvey and Ken Kennedy
  //  "A Simple, Fast Dominance Algorithm"
  private calculateDominatorNodesFromPostOrder(
    nodes: IHeapNodes,
    edges: IHeapEdges,
    postOrderInfo: PostOrderMapping,
    flags: Uint32Array,
    snapshot: IHeapSnapshot,
  ): Uint32Array {
    const {postOrderIndex2NodeIndex, nodeIndex2PostOrderIndex} = postOrderInfo;
    const nodeCount = nodes.length;

    const forwardEdges = edges;
    const firstEdgeIndexes = new Uint32Array(nodeCount + 1);
    firstEdgeIndexes[nodeCount] = forwardEdges.length;
    for (let nodeIndex = 0, edgeIndex = 0; nodeIndex < nodeCount; ++nodeIndex) {
      firstEdgeIndexes[nodeIndex] = edgeIndex;
      edgeIndex += (nodes.get(nodeIndex) as IHeapNode).edge_count;
    }

    const flag = PAGE_OBJECT_FLAG;
    const rootPostOrderedIndex = nodeCount - 1;
    const emptySlot = nodeCount;
    const dominators = new Uint32Array(nodeCount);
    for (let i = 0; i < rootPostOrderedIndex; ++i) {
      dominators[i] = emptySlot;
    }
    dominators[rootPostOrderedIndex] = rootPostOrderedIndex;

    // flag heap objects whose referrers changed and therefore
    // the dominators of those heap objects needs to be recomputed
    const nodesWithOutdatedDominatorInfo = new Uint8Array(nodeCount);
    // start from the direct children of the root node
    let nodeIndex = ROOT_NODE_INDEX;
    const endEdgeIndex = firstEdgeIndexes[nodeIndex + 1];
    for (
      let edgeIndex = firstEdgeIndexes[nodeIndex];
      edgeIndex < endEdgeIndex;
      edgeIndex++
    ) {
      const edgeType = (forwardEdges.get(edgeIndex) as IHeapEdge).type;
      if (!utils.isEssentialEdge(ROOT_NODE_INDEX, edgeType, ROOT_NODE_INDEX)) {
        continue;
      }
      const childNodeIndex = (forwardEdges.get(edgeIndex) as IHeapEdge).toNode
        .nodeIndex;
      nodesWithOutdatedDominatorInfo[
        nodeIndex2PostOrderIndex[childNodeIndex]
      ] = 1;
    }

    // now iterate through all nodes in the heap
    let dominatorInfoChanged = true;
    // iterate until no dominator info changed
    while (dominatorInfoChanged) {
      dominatorInfoChanged = false;
      for (
        let postOrderIndex = rootPostOrderedIndex - 1;
        postOrderIndex >= 0;
        --postOrderIndex
      ) {
        if (nodesWithOutdatedDominatorInfo[postOrderIndex] === 0) {
          continue;
        }
        nodesWithOutdatedDominatorInfo[postOrderIndex] = 0;
        // If dominator of the heap object has already been set to root node,
        // then the heap object's dominator can't be changed anymore
        if (dominators[postOrderIndex] === rootPostOrderedIndex) {
          continue;
        }
        nodeIndex = postOrderIndex2NodeIndex[postOrderIndex];
        const nodeFlag = flags[nodeIndex] & flag;
        let newDominatorIndex = emptySlot;
        let isOrphanNode = true;
        const node = nodes.get(nodeIndex) as IHeapNode;
        node.forEachReferrer((edge: IHeapEdge) => {
          const referrerEdgeType = edge.type;
          const referrerNodeIndex = edge.fromNode.nodeIndex;
          if (
            !utils.isEssentialEdge(
              referrerNodeIndex,
              referrerEdgeType,
              ROOT_NODE_INDEX,
            )
          ) {
            return;
          }
          isOrphanNode = false;
          const referrerNodeFlag = flags[referrerNodeIndex] & flag;
          // According to Chrome devtools, need to skip the edges from
          // non-page-owned nodes to page-owned nodes (since debugger may
          // also have references to heap objects)
          if (
            referrerNodeIndex !== ROOT_NODE_INDEX &&
            nodeFlag &&
            !referrerNodeFlag
          ) {
            return;
          }
          if (!this.shouldTraverseEdge(edge, snapshot)) {
            return;
          }
          let referrerPostOrderIndex =
            nodeIndex2PostOrderIndex[referrerNodeIndex];
          if (dominators[referrerPostOrderIndex] !== emptySlot) {
            if (newDominatorIndex === emptySlot) {
              newDominatorIndex = referrerPostOrderIndex;
            } else {
              while (referrerPostOrderIndex !== newDominatorIndex) {
                while (referrerPostOrderIndex < newDominatorIndex) {
                  referrerPostOrderIndex = dominators[referrerPostOrderIndex];
                }
                while (newDominatorIndex < referrerPostOrderIndex) {
                  newDominatorIndex = dominators[newDominatorIndex];
                }
              }
            }
            // no need to check any further if reaching the root node
            if (newDominatorIndex === rootPostOrderedIndex) {
              return {stop: true};
            }
          }
        });

        // set root node as the dominator of orphan nodes
        if (isOrphanNode) {
          newDominatorIndex = rootPostOrderedIndex;
        }
        if (
          newDominatorIndex !== emptySlot &&
          dominators[postOrderIndex] !== newDominatorIndex
        ) {
          dominators[postOrderIndex] = newDominatorIndex;
          dominatorInfoChanged = true;
          nodeIndex = postOrderIndex2NodeIndex[postOrderIndex];
          const node = nodes.get(nodeIndex) as IHeapNode;
          for (const edge of node.references) {
            nodesWithOutdatedDominatorInfo[
              nodeIndex2PostOrderIndex[edge.toNode.nodeIndex]
            ] = 1;
          }
        }
      }
    }

    const dominatorInfo = new Uint32Array(nodeCount);
    for (
      let postOrderIndex = 0, l = dominators.length;
      postOrderIndex < l;
      ++postOrderIndex
    ) {
      nodeIndex = postOrderIndex2NodeIndex[postOrderIndex];
      dominatorInfo[nodeIndex] =
        postOrderIndex2NodeIndex[dominators[postOrderIndex]];
    }
    return dominatorInfo;
  }

  private calculateRetainedSizesFromDominatorNodes(
    nodes: IHeapNodes,
    dominatorInfo: Uint32Array,
    postOrderInfo: PostOrderMapping,
  ): Float64Array {
    const {postOrderIndex2NodeIndex} = postOrderInfo;
    const nodeCount = nodes.length;
    const retainedSizes = new Float64Array(nodeCount);

    for (let nodeIndex = 0; nodeIndex < nodeCount; ++nodeIndex) {
      retainedSizes[nodeIndex] = (nodes.get(nodeIndex) as IHeapNode).self_size;
    }

    // add each heap object size to its dominator
    // based on the post order
    for (
      let postOrderIndex = 0;
      postOrderIndex < nodeCount - 1;
      ++postOrderIndex
    ) {
      const nodeIndex = postOrderIndex2NodeIndex[postOrderIndex];
      const dominatorIndex = dominatorInfo[nodeIndex];
      retainedSizes[dominatorIndex] += retainedSizes[nodeIndex];
    }

    return retainedSizes;
  }

  shouldIgnoreEdgeInTraceFinding(edge: IHeapEdge): boolean {
    const fromNode = edge.fromNode;
    const toNode = edge.toNode;
    const isDetachedNode = utils.isDetachedDOMNode(toNode);
    if (
      config.hideBrowserLeak &&
      utils.isBlinkRootNode(fromNode) &&
      isDetachedNode
    ) {
      return true;
    }
    if (
      !config.reportLeaksInTimers &&
      utils.isPendingActivityNode(fromNode) &&
      isDetachedNode
    ) {
      return true;
    }
    return false;
  }

  shouldTraverseEdge(
    edge: IHeapEdge,
    snapshot: IHeapSnapshot,
    options: AnyOptions = {},
  ): boolean {
    const shouldTraverseByDefault = this.shouldTraverseNodeByInternalStandard(
      edge,
      options,
    );
    const externalFilter = config.externalLeakFilter?.retainerReferenceFilter;
    if (externalFilter != null) {
      return externalFilter(edge, snapshot, shouldTraverseByDefault);
    }
    return shouldTraverseByDefault;
  }

  private shouldTraverseNodeByInternalStandard(
    edge: IHeapEdge,
    options: AnyOptions = {},
  ): boolean {
    if (this.isBlockListedEdge(edge)) {
      return false;
    }
    return utils.isMeaningfulEdge(edge, {includeString: true, ...options});
  }

  // remove edges that are already part of reported leaked paths
  isBlockListedEdge(edge: IHeapEdge): boolean {
    const nameOrIndex = edge.name_or_index;
    if (
      !config.traverseDevToolsConsole &&
      edge.type === 'internal' &&
      typeof nameOrIndex === 'string' &&
      nameOrIndex.indexOf('DevTools console') >= 0
    ) {
      return true;
    }
    if (config.edgeNameBlockList.has(String(nameOrIndex))) {
      return true;
    }
    if (config.nodeNameBlockList.has(edge.toNode.name)) {
      return true;
    }
    if (config.nodeNameBlockList.has(edge.fromNode.name)) {
      return true;
    }
    return false;
  }

  isLessPreferableEdge(edge: IHeapEdge): boolean {
    const fromNode = edge.fromNode;
    const toNode = edge.toNode;
    // pending activities -> DOM element is less preferrable
    if (
      utils.isPendingActivityNode(fromNode) &&
      utils.isDOMNodeIncomplete(toNode)
    ) {
      return true;
    }
    // detached DOM node -> non-detached DOM node is less preferable
    if (
      utils.isDetachedDOMNode(fromNode) &&
      utils.isDOMNodeIncomplete(toNode) &&
      !utils.isDetachedDOMNode(toNode)
    ) {
      return true;
    }
    // non-detached DOM node -> detached DOM node is less preferable
    if (
      utils.isDOMNodeIncomplete(fromNode) &&
      !utils.isDetachedDOMNode(fromNode) &&
      utils.isDetachedDOMNode(toNode)
    ) {
      return true;
    }
    return config.edgeNameGreyList.has(String(edge.name_or_index));
  }

  isLessPreferableNode(node: IHeapNode): boolean {
    return config.nodeNameGreyList.has(node.name) || utils.isCppRootsNode(node);
  }

  // each edge is indexed by fromNode's ID, toNode's ID, edge name, and edge type
  getEdgeKey(edge: IHeapEdge): string {
    const fromNode = edge.fromNode;
    const toNode = edge.toNode;
    return `${fromNode.id}|${edge.name_or_index}|${edge.type}|${toNode.id}`;
  }

  calculateAllNodesRetainedSizes(snapshot: IHeapSnapshot): void {
    info.overwrite('calculating dominators and retained sizes .');
    // step 1: build post order index
    const flags = new Uint32Array(snapshot.nodes.length);
    info.overwrite('calculating dominators and retained sizes ..');
    this.flagReachableNodesFromWindow(snapshot, flags, PAGE_OBJECT_FLAG);
    info.overwrite('calculating dominators and retained sizes ...');
    const postOrderInfo = this.buildPostOrderIndex(snapshot, flags);
    // step 2: build dominator relations
    info.overwrite('calculating dominators and retained sizes .');
    const dominatorInfo = this.calculateDominatorNodesFromPostOrder(
      snapshot.nodes,
      snapshot.edges,
      postOrderInfo,
      flags,
      snapshot,
    );
    // step 3: calculate retained sizes
    info.overwrite('calculating dominators and retained sizes ..');
    const retainedSizes = this.calculateRetainedSizesFromDominatorNodes(
      snapshot.nodes,
      dominatorInfo,
      postOrderInfo,
    );
    // step 4: assign retained sizes and dominators to nodes
    info.overwrite('calculating dominators and retained sizes ...');
    for (let i = 0; i < retainedSizes.length; i++) {
      const node = snapshot.nodes.get(i) as IHeapNode;
      node.retainedSize = retainedSizes[i];
      node.dominatorNode = snapshot.nodes.get(dominatorInfo[i]);
    }
  }

  annotateShortestPaths(
    snapshot: IHeapSnapshot,
    excludeKeySet?: HeapNodeIdSet,
  ): void {
    snapshot.clearShortestPathInfo();
    info.overwrite('annotating shortest path for all nodes');
    const [nodeRootLists, lowPriRootLists] = this.getRootNodeList(snapshot, {
      prioritize: true,
    });
    const nodeCount = snapshot.nodes.length;
    const visited = new Uint8Array(nodeCount);
    const queued = new Uint8Array(nodeCount);
    const traverseOption = {
      visited,
      queued,
      excludeWeakMapEdge: true,
      isForward: true,
    };
    let curQueue = nodeRootLists;
    const postponeQueue = [];
    while (curQueue.length > 0) {
      const nextQueue: IHeapNode[] = [];
      while (curQueue.length > 0) {
        const node = curQueue.pop() as IHeapNode;
        visited[node.nodeIndex] = 1;
        for (const edge of node.references) {
          const toNode = edge.toNode;
          // skip nodes that already have a parent
          if (toNode.hasPathEdge) {
            continue;
          }
          if (!this.shouldTraverseEdge(edge, snapshot, traverseOption)) {
            continue;
          }
          if (this.shouldIgnoreEdgeInTraceFinding(edge)) {
            continue;
          }
          if (utils.isWeakMapEdge(edge) && excludeKeySet) {
            const weakMapKeyObjectId = utils.getWeakMapEdgeKeyId(edge);
            if (excludeKeySet.has(weakMapKeyObjectId)) {
              continue;
            }
          }
          // postpone traversing edges and nodes that are less preferable
          if (
            this.isLessPreferableEdge(edge) ||
            this.isLessPreferableNode(toNode)
          ) {
            postponeQueue.push(edge);
          } else {
            toNode.pathEdge = edge;
            nextQueue.push(toNode);
          }
          queued[toNode.nodeIndex] = 1;
        }
      }
      // if no other preferable traces available
      // traverse the postpone queue
      while (nextQueue.length === 0 && postponeQueue.length > 0) {
        const edge = postponeQueue.pop() as IHeapEdge;
        const toNode = edge.toNode;
        if (toNode.hasPathEdge) {
          continue;
        }
        toNode.pathEdge = edge;
        nextQueue.push(toNode);
      }
      // if no other preferable traces available
      // consider the low priority root nodes
      while (nextQueue.length === 0 && lowPriRootLists.length > 0) {
        const root = lowPriRootLists.pop() as IHeapNode;
        if (root.hasPathEdge) {
          continue;
        }
        nextQueue.push(root);
      }
      curQueue = nextQueue;
    }
  }

  getPathToGCRoots(
    _snapshot: IHeapSnapshot,
    node: Nullable<IHeapNode>,
  ): Optional<LeakTracePathItem> {
    if (!node || !node.hasPathEdge) {
      return null;
    }
    let path: LeakTracePathItem = {node};
    while (node && node.hasPathEdge) {
      const edge: IHeapEdge = node.pathEdge as IHeapEdge;
      path = {node: edge.fromNode, edge, next: path};
      node = edge.fromNode;
    }
    return path;
  }
}

export default TraceFinder;
