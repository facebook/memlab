/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @lightSyntaxTransform
 * @format
 */

'use strict';

import type {
  IHeapNode,
  IHeapNodes,
  IHeapEdge,
  IHeapEdges,
  IHeapSnapshot,
  HeapNodeTypes,
  HeapEdgeTypes,
  HeapSnapshotMeta,
  RawHeapSnapshot,
  NumericDictionary,
  Nullable,
} from '../Types';

import config from '../Config';
import info from '../Console';
import HeapNode from './HeapNode';
import HeapEdge from './HeapEdge';
import {NodeDetachState, throwError} from './HeapUtils';

const EMPTY_UINT8_ARRAY = new Uint8Array(0);
const EMPTY_UINT32_ARRAY = new Uint32Array(0);

export default class HeapSnapshot implements IHeapSnapshot {
  public snapshot: RawHeapSnapshot;
  public nodes: IHeapNodes;
  public _nodeCount = -1;
  public edges: IHeapEdges;
  public _edgeCount = -1;
  public _nodeId2NodeIdx: NumericDictionary = {};
  public _nodeIdxHasPathEdge: Uint8Array = EMPTY_UINT8_ARRAY;
  public _nodeIdx2PathEdgeIdx: Uint32Array = EMPTY_UINT32_ARRAY;
  public _nodeIdx2DominatorNodeIdx: Uint32Array = EMPTY_UINT32_ARRAY;
  public _nodeIdxHasDominatorNode: Uint8Array = EMPTY_UINT8_ARRAY;
  public _nodeIdx2RetainedSize: NumericDictionary = {};
  public _additionalAttributes: Uint8Array = EMPTY_UINT8_ARRAY;
  public _nodeDetachednessOffset = -1;
  public _externalDetachedness: Uint8Array = EMPTY_UINT8_ARRAY;
  public _nodeIdx2LocationIdx: NumericDictionary = {};
  public _locationFieldsCount = -1;
  public _locationCount = -1;
  public _locationObjectIndexOffset = -1;
  public _nodeFieldsCount = -1;
  public _nodeIdOffset = -1;
  public forwardEdges: number[] = [];
  public _metaNode: HeapSnapshotMeta;
  public _nodeTypeOffset = -1;
  public _nodeNameOffset = -1;
  public _nodeSelfSizeOffset = -1;
  public _nodeEdgeCountOffset = -1;
  public _nodeTraceNodeIdOffset = -1;
  public _nodeTypes: HeapNodeTypes = [];
  public _nodeArrayType = -1;
  public _nodeHiddenType = -1;
  public _nodeObjectType = -1;
  public _nodeNativeType = -1;
  public _nodeConsStringType = -1;
  public _nodeSlicedStringType = -1;
  public _nodeCodeType = -1;
  public _nodeSyntheticType = -1;

  public _edgeFieldsCount = -1;
  public _edgeTypeOffset = -1;
  public _edgeNameOrIndexOffset = -1;
  public _edgeToNodeOffset = -1;

  public _edgeTypes: HeapEdgeTypes = [];
  public _edgeElementType = -1;
  public _edgeHiddenType = -1;
  public _edgeInternalType = -1;
  public _edgeShortcutType = -1;
  public _edgeWeakType = -1;
  public _edgeInvisibleType = -1;

  public _locationScriptIdOffset = -1;
  public _locationLineOffset = -1;
  public _locationColumnOffset = -1;
  public _firstEdgePointers: Uint32Array = EMPTY_UINT32_ARRAY;
  public _retainingEdgeIndex2EdgeIndex: Uint32Array = EMPTY_UINT32_ARRAY;
  public _firstRetainerIndex: Uint32Array = EMPTY_UINT32_ARRAY;
  public _edgeIndex2SrcNodeIndex: Uint32Array = EMPTY_UINT32_ARRAY;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(snapshot: RawHeapSnapshot, _options: Record<string, never> = {}) {
    this.snapshot = snapshot;
    this._metaNode = snapshot.snapshot.meta;
    this._buildMetaData();

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    // virtual nodes
    this.nodes = {
      length: self._nodeCount,
      get(idx: number): Nullable<IHeapNode> {
        if (idx < 0 || idx >= self._nodeCount) {
          return null;
        }
        return new HeapNode(self, idx);
      },
      forEach(cb) {
        for (let i = 0; i < this.length; i++) {
          const ret = cb(this.get(i) as IHeapNode, i);
          if (ret === false) {
            break;
          }
        }
      },
      forEachTraceable(cb) {
        for (let i = 0; i < this.length; i++) {
          const node = this.get(i) as IHeapNode;
          if (!node.pathEdge) {
            continue;
          }
          const ret = cb(node, i);
          if (ret === false) {
            break;
          }
        }
      },
    };

    // virtual edges
    this.edges = {
      length: self._edgeCount,
      get(idx): Nullable<IHeapEdge> {
        if (idx < 0 || idx >= self._edgeCount) {
          return null;
        }
        return new HeapEdge(self, idx);
      },
      forEach(cb) {
        for (let i = 0; i < this.length; i++) {
          const ret = cb(this.get(i) as IHeapEdge, i);
          if (ret === false) {
            break;
          }
        }
      },
    };
  }

  hasObjectWithClassName(className: string): boolean {
    let detected = false;
    this.nodes.forEach((node: IHeapNode) => {
      if (node.name === className && node.type === 'object') {
        detected = true;
        return false;
      }
    });
    return detected;
  }

  getAnyObjectWithClassName(className: string): Nullable<IHeapNode> {
    let ret = null;
    this.nodes.forEach((node: IHeapNode) => {
      if (node.name === className && node.type === 'object') {
        ret = node;
        return false;
      }
    });
    return ret;
  }

  hasObjectWithPropertyName(nameOrIndex: string | number): boolean {
    let detected = false;
    this.edges.forEach((edge: IHeapEdge) => {
      if (edge.name_or_index === nameOrIndex && edge.type === 'property') {
        detected = true;
        return false;
      }
    });
    return detected;
  }

  hasObjectWithTag(tag: string): boolean {
    // get tagStore
    let tagStore: Nullable<IHeapNode> = null;
    this.nodes.forEach((node: IHeapNode) => {
      if (node.name === 'MemLabTaggedStore' && node.type === 'object') {
        tagStore = node;
        return false;
      }
    });

    if (tagStore == null) {
      return false;
    }
    const store = tagStore as IHeapNode;

    // get tagStore.taggedObjects
    const taggedObjects = store.getReferenceNode('taggedObjects', 'property');
    if (taggedObjects == null) {
      return false;
    }

    // get taggedObjects[tag]
    const weakSet = taggedObjects.getReferenceNode(tag, 'property');
    if (weakSet == null) {
      return false;
    }

    // get weakSet.table
    const table = weakSet.getReferenceNode('table');
    if (table == null) {
      return false;
    }

    // check if the table has any weak reference to any object
    const ref = table.findAnyReference(
      (edge: IHeapEdge) =>
        edge.type === 'weak' && edge.toNode.name !== 'system / Oddball',
    );
    return ref != null;
  }

  getNodeById(id: number): Nullable<HeapNode> {
    if (!(id in this._nodeId2NodeIdx)) {
      return null;
    }
    const idx = this._nodeId2NodeIdx[id];
    return new HeapNode(this, idx);
  }

  clearShortestPathInfo(): void {
    this._nodeIdxHasPathEdge = new Uint8Array(this._nodeCount);
  }

  _buildMetaData(): void {
    this._calculateBasicInfo();
    this._buildReferencesIndex();
    this._buildReferrersIndex();
    this._propagateDetachednessState();
    this._buildNodeIdx();
    this._buildLocationIdx();
    this._buildExtraMetaData();
  }

  _buildExtraMetaData(): void {
    info.overwrite('building extra meta info...');
    // maps node index to the edge index (from edge) of its shortest path to GC root
    this._nodeIdx2PathEdgeIdx = new Uint32Array(this._nodeCount);
    this._nodeIdxHasPathEdge = new Uint8Array(this._nodeCount);
    // dominator node info
    this._nodeIdx2DominatorNodeIdx = new Uint32Array(this._nodeCount);
    this._nodeIdxHasDominatorNode = new Uint8Array(this._nodeCount);
    // retained size info
    this._nodeIdx2RetainedSize = Object.create(null);
    // additional attributes
    this._additionalAttributes = new Uint8Array(this._nodeCount);
    // additional detachedness info
    if (this._nodeDetachednessOffset < 0) {
      this._externalDetachedness = new Uint8Array(this._nodeCount);
    }
  }

  _buildLocationIdx(): void {
    info.overwrite('building location index...');
    this._nodeIdx2LocationIdx = Object.create(null);
    // iterate over locations
    const locations = this.snapshot.locations;
    const locationFieldsCount = this._locationFieldsCount;
    let locationIdx = 0;
    while (locationIdx < this._locationCount) {
      const id =
        locations[
          locationIdx * locationFieldsCount + this._locationObjectIndexOffset
        ];
      this._nodeIdx2LocationIdx[id] = locationIdx;
      ++locationIdx;
    }
  }

  _buildNodeIdx(): void {
    info.overwrite('building node index...');
    this._nodeId2NodeIdx = Object.create(null);
    // iterate over each node
    const nodeValues = this.snapshot.nodes;
    const nodeFieldsCount = this._nodeFieldsCount;
    let nodeIdx = 0;
    while (nodeIdx < this._nodeCount) {
      const id = nodeValues[nodeIdx * nodeFieldsCount + this._nodeIdOffset];
      this._nodeId2NodeIdx[id] = nodeIdx;
      ++nodeIdx;
    }
  }

  _calculateBasicInfo(): void {
    info.overwrite('calculating basic meta info...');
    this.forwardEdges = this.snapshot.edges;

    const meta = this._metaNode;
    const nodeFields = meta.node_fields;
    this._nodeTypeOffset = nodeFields.indexOf('type');
    this._nodeNameOffset = nodeFields.indexOf('name');
    this._nodeIdOffset = nodeFields.indexOf('id');
    this._nodeSelfSizeOffset = nodeFields.indexOf('self_size');
    this._nodeEdgeCountOffset = nodeFields.indexOf('edge_count');
    this._nodeTraceNodeIdOffset = nodeFields.indexOf('trace_node_id');
    this._nodeDetachednessOffset = nodeFields.indexOf('detachedness');
    config.snapshotHasDetachedness = this._nodeDetachednessOffset >= 0;
    this._nodeFieldsCount = nodeFields.length;

    const nodeTypes = meta.node_types[this._nodeTypeOffset] as HeapNodeTypes;
    this._nodeTypes = nodeTypes;
    this._nodeArrayType = nodeTypes.indexOf('array');
    this._nodeHiddenType = nodeTypes.indexOf('hidden');
    this._nodeObjectType = nodeTypes.indexOf('object');
    this._nodeNativeType = nodeTypes.indexOf('native');
    this._nodeConsStringType = nodeTypes.indexOf('concatenated string');
    this._nodeSlicedStringType = nodeTypes.indexOf('sliced string');
    this._nodeCodeType = nodeTypes.indexOf('code');
    this._nodeSyntheticType = nodeTypes.indexOf('synthetic');

    const edgeFields = meta.edge_fields;
    this._edgeFieldsCount = edgeFields.length;
    this._edgeTypeOffset = edgeFields.indexOf('type');
    this._edgeNameOrIndexOffset = edgeFields.indexOf('name_or_index');
    this._edgeToNodeOffset = edgeFields.indexOf('to_node');

    const edgeTypes = meta.edge_types[this._edgeTypeOffset] as HeapEdgeTypes;
    edgeFields.push('invisible');
    this._edgeTypes = edgeTypes;
    this._edgeElementType = edgeFields.indexOf('element');
    this._edgeHiddenType = edgeFields.indexOf('hidden');
    this._edgeInternalType = edgeFields.indexOf('internal');
    this._edgeShortcutType = edgeFields.indexOf('shortcut');
    this._edgeWeakType = edgeFields.indexOf('weak');
    this._edgeInvisibleType = edgeFields.indexOf('invisible');

    const locationFields = meta.location_fields || [];
    this._locationObjectIndexOffset = locationFields.indexOf('object_index');
    this._locationScriptIdOffset = locationFields.indexOf('script_id');
    this._locationLineOffset = locationFields.indexOf('line');
    this._locationColumnOffset = locationFields.indexOf('column');
    this._locationFieldsCount = locationFields.length;

    const snapshot = this.snapshot;
    this._nodeCount = snapshot.nodes.length / this._nodeFieldsCount;
    this._edgeCount = this.forwardEdges.length / this._edgeFieldsCount;
    this._locationCount = snapshot.locations.length / this._locationFieldsCount;
  }

  // create array that maps node index in node list to
  // the node's first edge index in forward edge list
  _buildReferencesIndex(): void {
    info.overwrite('building reference index...');
    this._firstEdgePointers = new Uint32Array(this._nodeCount + 1);

    const nodes = this.snapshot.nodes;
    const nodeCount = this._nodeCount;
    const firstEdgePointers = this._firstEdgePointers;
    const nodeFieldsCount = this._nodeFieldsCount;
    const edgeFieldsCount = this._edgeFieldsCount;
    const nodeEdgeCountOffset = this._nodeEdgeCountOffset;
    firstEdgePointers[nodeCount] = this.forwardEdges.length;
    let edgePointer = 0;
    for (let nodeIndex = 0; nodeIndex < nodeCount; ++nodeIndex) {
      firstEdgePointers[nodeIndex] = edgePointer;
      const nodeEdgeCountPointer =
        nodeIndex * nodeFieldsCount + nodeEdgeCountOffset;
      edgePointer += nodes[nodeEdgeCountPointer] * edgeFieldsCount;
    }
  }

  // build indexes for each node's retaining edge and retaining node
  _buildReferrersIndex(): void {
    info.overwrite('building referrers index...');
    // init data
    const retainingEdgeCount = new Uint32Array(this._edgeCount);
    this._retainingEdgeIndex2EdgeIndex = new Uint32Array(this._edgeCount);
    // index of the first retainer edge in _retainingEdgeIndex2EdgeIndex
    this._firstRetainerIndex = new Uint32Array(this._nodeCount + 1);
    // map edge index to source node index
    this._edgeIndex2SrcNodeIndex = new Uint32Array(this._edgeCount);

    // calculate retainers
    const edgeIndex2SrcNodeIndex = this._edgeIndex2SrcNodeIndex;
    const retainingEdgeIndex2EdgeIndex = this._retainingEdgeIndex2EdgeIndex;
    const firstRetainerIndex = this._firstRetainerIndex;

    const forwardEdges = this.forwardEdges;
    const edgeFieldsCount = this._edgeFieldsCount;
    const nodeFieldsCount = this._nodeFieldsCount;
    const edgeToNodeOffset = this._edgeToNodeOffset;
    const firstEdgePointers = this._firstEdgePointers;
    const nodeCount = this._nodeCount;

    // calculate the number of retainer nodes for each node
    // temporarily store the information in firstRetainerIndex
    for (
      let toNodeFieldIndex = edgeToNodeOffset;
      toNodeFieldIndex < forwardEdges.length;
      toNodeFieldIndex += edgeFieldsCount
    ) {
      const toNodeIndex = forwardEdges[toNodeFieldIndex];
      if (toNodeIndex % nodeFieldsCount) {
        throwError(new Error('Invalid toNodeIndex ' + toNodeIndex));
      }
      ++firstRetainerIndex[toNodeIndex / nodeFieldsCount];
    }

    // calculate the actual first retainer node index info
    // temporarily store the number of retainers in retainingNodes (sparsely)
    for (let i = 0, firstUnusedRetainerSlot = 0; i < nodeCount; i++) {
      const retainersCount = firstRetainerIndex[i];
      firstRetainerIndex[i] = firstUnusedRetainerSlot;
      retainingEdgeCount[firstUnusedRetainerSlot] = retainersCount;
      firstUnusedRetainerSlot += retainersCount;
    }
    firstRetainerIndex[nodeCount] = retainingEdgeCount.length;

    // calculate a compact array containing retainer node and retainer edge
    let nextNodeFirstEdgePointer = firstEdgePointers[0];
    for (let srcNodeIndex = 0; srcNodeIndex < nodeCount; ++srcNodeIndex) {
      const firstEdgePointer = nextNodeFirstEdgePointer;
      nextNodeFirstEdgePointer = firstEdgePointers[srcNodeIndex + 1];
      for (
        let edgePointer = firstEdgePointer;
        edgePointer < nextNodeFirstEdgePointer;
        edgePointer += edgeFieldsCount
      ) {
        const toNodePointer = forwardEdges[edgePointer + edgeToNodeOffset];
        if (toNodePointer % nodeFieldsCount) {
          throwError(Error('Invalid toNodeIndex ' + toNodePointer));
        }
        const toNodeIndex = toNodePointer / nodeFieldsCount;
        const firstRetainerSlotIndex = firstRetainerIndex[toNodeIndex];
        const nextUnusedRetainerSlotIndex =
          firstRetainerSlotIndex + --retainingEdgeCount[firstRetainerSlotIndex];
        const edgeIndex = edgePointer / edgeFieldsCount;
        retainingEdgeIndex2EdgeIndex[nextUnusedRetainerSlotIndex] = edgeIndex;
        edgeIndex2SrcNodeIndex[edgeIndex] = srcNodeIndex;
      }
    }
  }

  // a helper function that iterates the direct children of a given node
  _iterateDirectChildren(
    nodeIndex: number,
    edgeFilterCallback: (edgeType: number) => boolean,
    childCallback: (nodeIndex: number) => void,
  ): void {
    const beginEdgePointer = this._firstEdgePointers[nodeIndex];
    const endEdgePointer = this._firstEdgePointers[nodeIndex + 1];
    for (
      let edgePointer = beginEdgePointer;
      edgePointer < endEdgePointer;
      edgePointer += this._edgeFieldsCount
    ) {
      const childNodePointer =
        this.forwardEdges[edgePointer + this._edgeToNodeOffset];
      const childNodeIndex = childNodePointer / this._nodeFieldsCount;
      const type = this.forwardEdges[edgePointer + this._edgeTypeOffset];
      if (!edgeFilterCallback(type)) {
        continue;
      }
      childCallback(childNodeIndex);
    }
  }

  // initial detachedness state is available at entry point to native node
  // this helper function propagate the detachedness state to connected
  // native node (mainly DOM elements)
  _propagateDetachednessState(): void {
    if (this._nodeDetachednessOffset === -1) {
      return;
    }
    info.overwrite('propagating detachedness state...');

    const visited = new Uint8Array(this._nodeCount);
    const attached: number[] = [];
    const detached: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const setNodeDetachState = function (
      snapshot: RawHeapSnapshot,
      nodeIndex: number,
      detachedness: number,
    ) {
      if (visited[nodeIndex] === 1) {
        return;
      }

      const nodePointer = nodeIndex * self._nodeFieldsCount;
      // Do not propagate the state (and name change) through JavaScript.
      // From V8: Every entry point into embedder code is a node that knows
      // its own state. All embedder nodes have their node type set to native.
      if (
        snapshot.nodes[nodePointer + self._nodeTypeOffset] !==
        self._nodeNativeType
      ) {
        visited[nodeIndex] = 1;
        return;
      }

      snapshot.nodes[nodePointer + self._nodeDetachednessOffset] = detachedness;

      if (detachedness === NodeDetachState.Attached) {
        attached.push(nodeIndex);
      } else if (detachedness === NodeDetachState.Detached) {
        detached.push(nodeIndex);
      }

      visited[nodeIndex] = 1;
    };

    const hiddenEdgeTypes = [
      self._edgeHiddenType,
      self._edgeInvisibleType,
      self._edgeWeakType,
    ];
    const filterEdge = function (edgeType: number) {
      return hiddenEdgeTypes.indexOf(edgeType) < 0;
    };

    const propagate = function (
      snapshot: RawHeapSnapshot,
      nodeIndex: number,
      detachedness: number,
    ) {
      self._iterateDirectChildren(nodeIndex, filterEdge, childNodeIndex =>
        setNodeDetachState(snapshot, childNodeIndex, detachedness),
      );
    };

    // add attached and detached nodes to queue
    for (let nodeIndex = 0; nodeIndex < this._nodeCount; ++nodeIndex) {
      const state =
        this.snapshot.nodes[
          nodeIndex * this._nodeFieldsCount + this._nodeDetachednessOffset
        ];
      if (state === NodeDetachState.Unknown) {
        continue;
      }
      setNodeDetachState(this.snapshot, nodeIndex, state);
    }

    // if the parent is attached, then the child is also attached
    while (attached.length > 0) {
      const nodeIndex = attached.pop();
      if (nodeIndex != null) {
        propagate(this.snapshot, nodeIndex, NodeDetachState.Attached);
      }
    }

    // if the parent is not attached, then the child inherits the parent's state
    while (detached.length > 0) {
      const nodeIndex = detached.pop();
      if (nodeIndex == null) {
        continue; // make TS code strict mode happy
      }
      const detachedness =
        this.snapshot.nodes[
          nodeIndex * this._nodeFieldsCount + this._nodeDetachednessOffset
        ];
      if (detachedness === NodeDetachState.Attached) {
        continue;
      }
      propagate(this.snapshot, nodeIndex, NodeDetachState.Detached);
    }
  }
}
