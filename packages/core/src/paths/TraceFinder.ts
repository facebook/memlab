/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {
  AnyOptions,
  HeapNodeIdSet,
  IHeapEdge,
  IHeapNode,
  IHeapSnapshot,
  LeakTracePathItem,
  Nullable,
  Optional,
  Predicator,
} from '../lib/Types';

import config from '../lib/Config';
import info from '../lib/Console';
import utils from '../lib/Utils';
import NumericSet from '../lib/heap-data/utils/NumericSet';

const ROOT_NODE_INDEX = 0;
const PAGE_OBJECT_FLAG = 1;

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
    const queuedIDs = new NumericSet(queue.map(n => n.id));
    const visitedIDs = new NumericSet();
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

  // Build the dominator tree and retained sizes using the Lengauer-Tarjan
  // algorithm:
  //   Thomas Lengauer and Robert Endre Tarjan. 1979. A fast algorithm for
  //   finding dominators in a flowgraph. ACM Trans. Program. Lang. Syst. 1, 1
  //   (July 1979), 121-141. https://doi.org/10.1145/357062.357071
  //
  // This is the same near-linear, single-pass algorithm Chrome DevTools uses.
  // It replaces the previous iterative Cooper-Harvey-Kennedy fix-point, which
  // had two problems on real browser snapshots:
  //   1. It could spin forever. The fix-point's two-finger intersect() walk
  //      assumes every step climbs toward the root, but the post-order that was
  //      assigned to orphan / weakly-reachable nodes (unreachable from the GC
  //      root) could violate that, producing a cycle in the provisional
  //      dominator pointers or a walk onto the out-of-bounds "empty" sentinel.
  //      The walk then never terminated -- one CPU pinned at 100% with a flat
  //      heap, stuck at "calculating dominators and retained sizes".
  //   2. Even when it converged it needed O(graph-depth) sweeps.
  //
  // Lengauer-Tarjan avoids both: it assigns every node a valid DFS number,
  // treats orphan and mutually-retaining "clique" nodes as retained by the
  // root, and computes dominators in a single pass with no fix-point.
  //
  // Vertices are numbered 1..nodeCount (0 is the invalid/empty value the
  // algorithm relies on); ordinal === vertex - 1 maps a vertex back to its heap
  // node index.
  private computeDominatorsAndRetainedSizes(
    snapshot: IHeapSnapshot,
    flags: Uint32Array,
  ): {dominatorOrdinals: Uint32Array; retainedSizes: Float64Array} {
    const nodes = snapshot.nodes;
    const edges = snapshot.edges;
    const nodeCount = nodes.length;
    const flag = PAGE_OBJECT_FLAG;

    // Offset of each node's first outgoing edge in the flat edge list.
    const firstEdgeIndexes = new Uint32Array(nodeCount + 1);
    firstEdgeIndexes[nodeCount] = edges.length;
    for (let ordinal = 0, edgeIndex = 0; ordinal < nodeCount; ++ordinal) {
      firstEdgeIndexes[ordinal] = edgeIndex;
      edgeIndex += (nodes.get(ordinal) as IHeapNode).edge_count;
    }

    // A single essential-edge predicate used for BOTH the forward DFS and the
    // backward retainer scan, so the two passes agree on exactly which edges
    // exist. (A disagreement between them -- the forward pass omitting a filter
    // the backward pass applied -- is what corrupted the old dominator relation
    // and caused the hang.) Mirrors Chrome DevTools' computeIsEssentialEdge:
    // skip weak edges, non-root shortcut edges, self edges, and edges from a
    // non-page-owned node into a page-owned node (otherwise the debugger's own
    // references would perturb product-object dominators).
    const isEssential = (
      fromOrdinal: number,
      edgeType: string,
      toOrdinal: number,
    ): boolean => {
      if (fromOrdinal === toOrdinal) {
        return false;
      }
      if (!utils.isEssentialEdge(fromOrdinal, edgeType, ROOT_NODE_INDEX)) {
        return false;
      }
      if (
        fromOrdinal !== ROOT_NODE_INDEX &&
        flags[toOrdinal] & flag &&
        !(flags[fromOrdinal] & flag)
      ) {
        return false;
      }
      return true;
    };

    // Lengauer-Tarjan working arrays, 1-indexed (index 0 == invalid).
    const arrayLength = nodeCount + 1;
    const parent = new Uint32Array(arrayLength);
    const ancestor = new Uint32Array(arrayLength);
    const vertex = new Uint32Array(arrayLength);
    const label = new Uint32Array(arrayLength);
    const semi = new Uint32Array(arrayLength);
    const dom = new Uint32Array(arrayLength);
    const bucket = new Array<Set<number>>(arrayLength);
    // Resumable per-node edge cursor for the iterative DFS.
    const nextEdgeIndex = new Uint32Array(arrayLength);
    let n = 0;

    // Iterative DFS (a recursive version overflows the stack on large heaps).
    const dfs = (root: number): void => {
      const rootOrdinal = root - 1;
      nextEdgeIndex[rootOrdinal] = firstEdgeIndexes[rootOrdinal];
      let v = root;
      while (v !== 0) {
        // Number v the first time it is reached.
        if (semi[v] === 0) {
          semi[v] = ++n;
          vertex[n] = label[v] = v;
        }
        // The next node to visit is v's first unprocessed essential successor,
        // else v's parent (backtrack).
        let vNext = parent[v];
        const vOrdinal = v - 1;
        const edgesEnd = firstEdgeIndexes[vOrdinal + 1];
        for (; nextEdgeIndex[vOrdinal] < edgesEnd; ++nextEdgeIndex[vOrdinal]) {
          const edge = edges.get(nextEdgeIndex[vOrdinal]) as IHeapEdge;
          const wOrdinal = edge.toNode.nodeIndex;
          if (!isEssential(vOrdinal, edge.type, wOrdinal)) {
            continue;
          }
          const w = wOrdinal + 1;
          if (semi[w] === 0) {
            parent[w] = v;
            nextEdgeIndex[wOrdinal] = firstEdgeIndexes[wOrdinal];
            vNext = w;
            break;
          }
        }
        v = vNext;
      }
    };

    // eval/link with path compression, iterative to avoid deep recursion.
    const compressionStack = new Uint32Array(arrayLength);
    const compress = (node: number): void => {
      let v = node;
      let stackPointer = 0;
      while (ancestor[ancestor[v]] !== 0) {
        compressionStack[++stackPointer] = v;
        v = ancestor[v];
      }
      while (stackPointer > 0) {
        const w = compressionStack[stackPointer--];
        if (semi[label[ancestor[w]]] < semi[label[w]]) {
          label[w] = label[ancestor[w]];
        }
        ancestor[w] = ancestor[ancestor[w]];
      }
    };
    const evaluate = (v: number): number => {
      if (ancestor[v] === 0) {
        return v;
      }
      compress(v);
      return label[v];
    };
    const link = (v: number, w: number): void => {
      ancestor[w] = v;
    };

    const r = ROOT_NODE_INDEX + 1;

    // Step 1: DFS from the root.
    dfs(r);

    // Step 2: nodes may remain unreachable from the root. First bring in
    // orphans that have only weak retainers, DFS-ing from each.
    if (n < nodeCount) {
      for (let v = 1; v <= nodeCount; ++v) {
        if (
          semi[v] === 0 &&
          utils.hasOnlyWeakReferrers(nodes.get(v - 1) as IHeapNode)
        ) {
          parent[v] = r;
          dfs(v);
        }
      }
    }

    // Step 3: whatever is still unreachable is a clique of nodes retained only
    // by one another. Attach each directly under the root and give it a DFS
    // number so the algorithm is well-defined for every node.
    if (n < nodeCount) {
      for (let v = 1; v <= nodeCount; ++v) {
        if (semi[v] === 0) {
          parent[v] = r;
          semi[v] = ++n;
          vertex[n] = label[v] = v;
        }
      }
    }

    // Step 4: main loop, processing vertices in decreasing DFS number.
    for (let i = n; i >= 2; --i) {
      const w = vertex[i];
      const wOrdinal = w - 1;
      // Compute semidominator of w from its (essential) predecessors.
      let isOrphanNode = true;
      (nodes.get(wOrdinal) as IHeapNode).forEachReferrer((edge: IHeapEdge) => {
        const vOrdinal = edge.fromNode.nodeIndex;
        if (!isEssential(vOrdinal, edge.type, wOrdinal)) {
          return;
        }
        isOrphanNode = false;
        const u = evaluate(vOrdinal + 1);
        if (semi[u] < semi[w]) {
          semi[w] = semi[u];
        }
      });
      // Treat an orphan as retained by the root; semi[r] is <= any other semi.
      if (isOrphanNode) {
        semi[w] = semi[r];
      }

      const semidominator = vertex[semi[w]];
      if (bucket[semidominator] === undefined) {
        bucket[semidominator] = new Set<number>();
      }
      bucket[semidominator].add(w);
      link(parent[w], w);

      // Process the vertices in bucket(parent(w)).
      const parentBucket = bucket[parent[w]];
      if (parentBucket !== undefined) {
        for (const v of parentBucket) {
          const u = evaluate(v);
          dom[v] = semi[u] < semi[v] ? u : parent[w];
        }
        parentBucket.clear();
      }
    }

    // Step 5: fill in the immediate dominators not computed explicitly above.
    // The root is treated as its own dominator, which also propagates the root
    // as the dominator of any unreachable node.
    dom[0] = dom[r] = r;
    for (let i = 2; i <= n; ++i) {
      const w = vertex[i];
      if (dom[w] !== vertex[semi[w]]) {
        dom[w] = dom[dom[w]];
      }
    }

    // Convert to ordinal-indexed dominators and seed retained sizes with self
    // sizes.
    const dominatorOrdinals = new Uint32Array(nodeCount);
    const retainedSizes = new Float64Array(nodeCount);
    for (let ordinal = 0; ordinal < nodeCount; ++ordinal) {
      dominatorOrdinals[ordinal] = dom[ordinal + 1] - 1;
      retainedSizes[ordinal] = (nodes.get(ordinal) as IHeapNode).self_size;
    }

    // Propagate retained sizes up the dominator tree in reverse DFS order, so
    // each node is accumulated into its dominator before the dominator itself.
    // vertex[1] is the root, so stop at i > 1.
    for (let i = n; i > 1; --i) {
      const ordinal = vertex[i] - 1;
      retainedSizes[dominatorOrdinals[ordinal]] += retainedSizes[ordinal];
    }

    return {dominatorOrdinals, retainedSizes};
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
    const nodes = snapshot.nodes;
    // Flag nodes owned by the page (reachable from the window) so the dominator
    // pass can ignore edges the debugger adds into page-owned objects.
    const flags = new Uint32Array(nodes.length);
    this.flagReachableNodesFromWindow(snapshot, flags, PAGE_OBJECT_FLAG);
    info.overwrite('calculating dominators and retained sizes ..');
    const {dominatorOrdinals, retainedSizes} =
      this.computeDominatorsAndRetainedSizes(snapshot, flags);
    // assign retained sizes and dominators to nodes
    info.overwrite('calculating dominators and retained sizes ...');
    for (let ordinal = 0; ordinal < retainedSizes.length; ++ordinal) {
      const node = nodes.get(ordinal) as IHeapNode;
      node.retainedSize = retainedSizes[ordinal];
      node.dominatorNode = nodes.get(dominatorOrdinals[ordinal]);
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
    const visited = new Set<number>([node.id]);
    let path: LeakTracePathItem = {node};
    while (node && node.hasPathEdge) {
      const edge: IHeapEdge = node.pathEdge as IHeapEdge;
      const fromNode = edge.fromNode;
      if (visited.has(fromNode.id)) {
        return null;
      }
      visited.add(fromNode.id);
      path = {node: fromNode, edge, next: path};
      node = edge.fromNode;
    }
    return path;
  }
}

export default TraceFinder;
