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

import config from './Config';
import info from './Console';
import stringLoader from './StringLoader';
import type {
  IHeapNode,
  IHeapNodes,
  IHeapEdge,
  IHeapEdges,
  IHeapLocation,
  IHeapSnapshot,
  HeapNodeTypes,
  HeapEdgeTypes,
  HeapSnapshotMeta,
  HeapSnapshotInfo,
  RawHeapSnapshot,
  NumericDictionary,
  Nullable,
  EdgeIterationCallback,
  Predicator,
} from './Types';

function throwError(error: Error) {
  if (error) {
    error.stack;
  }
  throw error;
}

class HeapNode implements IHeapNode {
  constructor(private heapSnapshot: HeapSnapshot, private idx: number) {}

  get snapshot(): HeapSnapshot {
    return this.heapSnapshot;
  }

  get type(): string {
    const heapSnapshot = this.heapSnapshot;
    const nodeValues = heapSnapshot.snapshot.nodes;
    const nodeFieldsCount = heapSnapshot._nodeFieldsCount;
    const nodeTypes = heapSnapshot._nodeTypes;
    const typeIdx =
      nodeValues[this.idx * nodeFieldsCount + heapSnapshot._nodeTypeOffset];
    return nodeTypes[typeIdx];
  }

  get name(): string {
    const heapSnapshot = this.heapSnapshot;
    const nodeValues = heapSnapshot.snapshot.nodes;
    const nodeFieldsCount = heapSnapshot._nodeFieldsCount;
    const strIdx =
      nodeValues[this.idx * nodeFieldsCount + heapSnapshot._nodeNameOffset];
    const prefix = this.is_detached ? 'Detached ' : '';
    return prefix + heapSnapshot.snapshot.strings[strIdx];
  }

  get is_detached(): boolean {
    const heapSnapshot = this.heapSnapshot;
    if (heapSnapshot._nodeDetachednessOffset < 0) {
      return (
        heapSnapshot._externalDetachedness[this.idx] ===
        NodeDetachState.Detached
      );
    }
    const nodeValues = heapSnapshot.snapshot.nodes;
    const nodeFieldsCount = heapSnapshot._nodeFieldsCount;
    const detachState =
      nodeValues[
        this.idx * nodeFieldsCount + heapSnapshot._nodeDetachednessOffset
      ];
    return detachState === NodeDetachState.Detached;
  }

  set detachState(detachState: number) {
    const heapSnapshot = this.heapSnapshot;
    if (heapSnapshot._nodeDetachednessOffset >= 0) {
      const nodeValues = heapSnapshot.snapshot.nodes;
      const nodeFieldsCount = heapSnapshot._nodeFieldsCount;
      nodeValues[
        this.idx * nodeFieldsCount + heapSnapshot._nodeDetachednessOffset
      ] = detachState;
    } else {
      heapSnapshot._externalDetachedness[this.idx] = detachState;
    }
  }

  markAsDetached(): void {
    this.detachState = NodeDetachState.Detached;
  }

  get attributes(): number {
    const heapSnapshot = this.heapSnapshot;
    const nodeAttributes = heapSnapshot._additionalAttributes;
    return nodeAttributes[this.idx];
  }

  set attributes(attr: number) {
    const heapSnapshot = this.heapSnapshot;
    const nodeAttributes = heapSnapshot._additionalAttributes;
    nodeAttributes[this.idx] = attr;
  }

  get id(): number {
    const heapSnapshot = this.heapSnapshot;
    const nodeValues = heapSnapshot.snapshot.nodes;
    const nodeFieldsCount = heapSnapshot._nodeFieldsCount;
    const id =
      nodeValues[this.idx * nodeFieldsCount + heapSnapshot._nodeIdOffset];
    return id;
  }

  get self_size(): number {
    const heapSnapshot = this.heapSnapshot;
    const nodeValues = heapSnapshot.snapshot.nodes;
    const nodeFieldsCount = heapSnapshot._nodeFieldsCount;
    return nodeValues[
      this.idx * nodeFieldsCount + heapSnapshot._nodeSelfSizeOffset
    ];
  }

  get edge_count(): number {
    const heapSnapshot = this.heapSnapshot;
    const nodeValues = heapSnapshot.snapshot.nodes;
    const nodeFieldsCount = heapSnapshot._nodeFieldsCount;
    return nodeValues[
      this.idx * nodeFieldsCount + heapSnapshot._nodeEdgeCountOffset
    ];
  }

  get trace_node_id(): number {
    const heapSnapshot = this.heapSnapshot;
    const nodeValues = heapSnapshot.snapshot.nodes;
    const nodeFieldsCount = heapSnapshot._nodeFieldsCount;
    return nodeValues[
      this.idx * nodeFieldsCount + heapSnapshot._nodeTraceNodeIdOffset
    ];
  }

  get references(): HeapEdge[] {
    const ret = [];
    const heapSnapshot = this.heapSnapshot;
    const edgeFieldsCount = heapSnapshot._edgeFieldsCount;
    const firstEdgePointers = heapSnapshot._firstEdgePointers;
    const beginEdgeIdx = firstEdgePointers[this.idx];
    const endEdgeIdx = firstEdgePointers[this.idx + 1];
    for (
      let edgeIdx = beginEdgeIdx;
      edgeIdx < endEdgeIdx;
      edgeIdx += edgeFieldsCount
    ) {
      ret.push(new HeapEdge(heapSnapshot, edgeIdx / edgeFieldsCount));
    }
    return ret;
  }

  forEachReference(callback: EdgeIterationCallback): void {
    const heapSnapshot = this.heapSnapshot;
    const edgeFieldsCount = heapSnapshot._edgeFieldsCount;
    const firstEdgePointers = heapSnapshot._firstEdgePointers;
    const beginEdgeIdx = firstEdgePointers[this.idx];
    const endEdgeIdx = firstEdgePointers[this.idx + 1];
    for (
      let edgeIdx = beginEdgeIdx;
      edgeIdx < endEdgeIdx;
      edgeIdx += edgeFieldsCount
    ) {
      const edge = new HeapEdge(heapSnapshot, edgeIdx / edgeFieldsCount);
      const ret = callback(edge);
      if (ret && ret.stop) {
        break;
      }
    }
  }

  findReference(predicate: Predicator<IHeapEdge>): Nullable<IHeapEdge> {
    let found: Nullable<IHeapEdge> = null;
    this.forEachReference((edge: IHeapEdge) => {
      if (predicate(edge)) {
        found = edge;
        return {stop: true};
      }
    });
    return found;
  }

  findAnyReferrer(predicate: Predicator<IHeapEdge>): Nullable<IHeapEdge> {
    let found: Nullable<IHeapEdge> = null;
    this.forEachReferrer((edge: IHeapEdge) => {
      if (predicate(edge)) {
        found = edge;
        return {stop: true};
      }
    });
    return found;
  }

  findReferrers(predicate: Predicator<IHeapEdge>): IHeapEdge[] {
    const ret: IHeapEdge[] = [];
    this.forEachReferrer((edge: IHeapEdge) => {
      if (predicate(edge)) {
        ret.push(edge);
      }
      return null;
    });
    return ret;
  }

  get referrers(): HeapEdge[] {
    const heapSnapshot = this.heapSnapshot;
    const retainingEdgeIndex2EdgeIndex =
      heapSnapshot._retainingEdgeIndex2EdgeIndex;
    const firstRetainerIndex = heapSnapshot._firstRetainerIndex;
    const ret = [];
    const beginIdx = firstRetainerIndex[this.idx];
    const endIdx = firstRetainerIndex[this.idx + 1];
    for (let idx = beginIdx; idx < endIdx; idx++) {
      const retainingEdgeIdx = retainingEdgeIndex2EdgeIndex[idx];
      ret.push(new HeapEdge(heapSnapshot, retainingEdgeIdx));
    }
    return ret;
  }

  forEachReferrer(callback: EdgeIterationCallback): void {
    const heapSnapshot = this.heapSnapshot;
    const retainingEdgeIndex2EdgeIndex =
      heapSnapshot._retainingEdgeIndex2EdgeIndex;
    const firstRetainerIndex = heapSnapshot._firstRetainerIndex;
    const beginIdx = firstRetainerIndex[this.idx];
    const endIdx = firstRetainerIndex[this.idx + 1];
    for (let idx = beginIdx; idx < endIdx; idx++) {
      const retainingEdgeIdx = retainingEdgeIndex2EdgeIndex[idx];
      const edge = new HeapEdge(heapSnapshot, retainingEdgeIdx);
      const ret = callback(edge);
      if (ret && ret.stop) {
        break;
      }
    }
  }

  get pathEdge(): Nullable<HeapEdge> {
    const heapSnapshot = this.heapSnapshot;
    if (heapSnapshot._nodeIdxHasPathEdge[this.idx] === 0) {
      return null;
    }
    if (this.idx >= heapSnapshot._nodeIdx2PathEdgeIdx.length) {
      throwError(new Error('invalid idx: ' + this.idx));
    }
    const edgeIdx = heapSnapshot._nodeIdx2PathEdgeIdx[this.idx];
    return new HeapEdge(heapSnapshot, edgeIdx);
  }

  set pathEdge(edge: Nullable<HeapEdge>) {
    const heapSnapshot = this.heapSnapshot;
    if (!edge) {
      heapSnapshot._nodeIdxHasPathEdge[this.idx] = 0;
      return;
    }
    const edgeIdx = edge.edgeIndex;
    if (this.idx >= heapSnapshot._nodeIdx2PathEdgeIdx.length) {
      throwError(new Error('invalid idx: ' + this.idx));
    }
    heapSnapshot._nodeIdx2PathEdgeIdx[this.idx] = edgeIdx;
    heapSnapshot._nodeIdxHasPathEdge[this.idx] = 1;
  }

  get nodeIndex(): number {
    return this.idx;
  }

  get retainedSize(): number {
    return this.heapSnapshot._nodeIdx2RetainedSize[this.idx];
  }

  set retainedSize(size: number) {
    const heapSnapshot = this.heapSnapshot;
    heapSnapshot._nodeIdx2RetainedSize[this.idx] = size;
  }

  get dominatorNode(): Nullable<HeapNode> {
    const heapSnapshot = this.heapSnapshot;
    const nodeIdx2DominatorNodeIdx = heapSnapshot._nodeIdx2DominatorNodeIdx;
    if (this.idx >= nodeIdx2DominatorNodeIdx.length) {
      throwError(new Error('invalid idx: ' + this.idx));
    }
    if (heapSnapshot._nodeIdxHasDominatorNode[this.idx] === 0) {
      return null;
    }
    const dominatorNodeIdx = nodeIdx2DominatorNodeIdx[this.idx];
    return new HeapNode(heapSnapshot, dominatorNodeIdx);
  }

  set dominatorNode(node: Nullable<HeapNode>) {
    const heapSnapshot = this.heapSnapshot;
    if (!node) {
      heapSnapshot._nodeIdxHasDominatorNode[this.idx] = 0;
      return;
    }
    const nodeIdx2DominatorNodeIdx = heapSnapshot._nodeIdx2DominatorNodeIdx;
    const dominatorNodeIdx = node.nodeIndex;
    if (
      this.idx >= nodeIdx2DominatorNodeIdx.length ||
      dominatorNodeIdx >= nodeIdx2DominatorNodeIdx.length
    ) {
      throwError(new Error('invalid idx: ' + this.idx));
    }
    nodeIdx2DominatorNodeIdx[this.idx] = dominatorNodeIdx;
    heapSnapshot._nodeIdxHasDominatorNode[this.idx] = 1;
  }

  get location(): Nullable<HeapLocation> {
    const heapSnapshot = this.heapSnapshot;
    const locationIdx = heapSnapshot._nodeIdx2LocationIdx[this.idx];
    if (locationIdx === undefined) {
      return null;
    }
    return new HeapLocation(heapSnapshot, locationIdx);
  }

  // search reference by edge name and edge type
  getReference(
    edgeName: string | number,
    edgeType?: string,
  ): Nullable<IHeapEdge> {
    let ret: Nullable<IHeapEdge> = null;
    this.forEachReference((edge: IHeapEdge) => {
      if (edge.name_or_index !== edgeName) {
        return;
      }
      if (edgeType != null && edge.type !== edgeType) {
        return;
      }
      ret = edge;
      return {stop: true};
    });
    return ret;
  }

  // search referenced node by edge name and edge type
  getReferenceNode(
    edgeName: string | number,
    edgeType?: string,
  ): Nullable<IHeapNode> {
    const edge = this.getReference(edgeName, edgeType);
    return edge && edge.toNode;
  }

  // search any referrer edge by edge name and edge type
  getAnyReferrer(
    edgeName: string | number,
    edgeType?: string,
  ): Nullable<IHeapEdge> {
    let ret: Nullable<IHeapEdge> = null;
    this.forEachReferrer((edge: IHeapEdge) => {
      if (edge.name_or_index !== edgeName) {
        return;
      }
      if (edgeType != null && edge.type !== edgeType) {
        return;
      }
      ret = edge;
      return {stop: true};
    });
    return ret;
  }

  // search all referrer edges by edge name and edge type
  getReferrers(edgeName: string | number, edgeType?: string): IHeapEdge[] {
    return this.findReferrers((edge: IHeapEdge) => {
      if (edge.name_or_index !== edgeName) {
        return false;
      }
      if (edgeType != null && edge.type !== edgeType) {
        return false;
      }
      return true;
    });
  }

  // search any referrer node by edge name and edge type
  getAnyReferrerNode(
    edgeName: string | number,
    edgeType?: string,
  ): Nullable<IHeapNode> {
    const edge = this.getAnyReferrer(edgeName, edgeType);
    return edge && edge.fromNode;
  }

  // search all referrer nodes by edge name and edge type
  getReferrerNodes(edgeName: string | number, edgeType?: string): IHeapNode[] {
    const ret: IHeapNode[] = [];
    const idSet = new Set();
    this.forEachReferrer((edge: IHeapEdge) => {
      if (edge.name_or_index !== edgeName) {
        return;
      }
      if (edgeType != null && edge.type !== edgeType) {
        return;
      }
      const fromNode = edge.fromNode;
      if (idSet.has(fromNode.id)) {
        return;
      }
      idSet.add(fromNode.id);
      ret.push(fromNode);
      return null;
    });
    return ret;
  }
}

class HeapEdge implements IHeapEdge {
  constructor(private heapSnapshot: HeapSnapshot, private idx: number) {}

  get snapshot(): HeapSnapshot {
    return this.heapSnapshot;
  }

  get edgeIndex(): number {
    return this.idx;
  }

  get type(): string {
    const heapSnapshot = this.heapSnapshot;
    const edgeValues = heapSnapshot.snapshot.edges;
    const edgeFieldsCount = heapSnapshot._edgeFieldsCount;
    const edgeTypes = heapSnapshot._edgeTypes;
    const typeIdx =
      edgeValues[this.idx * edgeFieldsCount + heapSnapshot._edgeTypeOffset];
    return edgeTypes[typeIdx];
  }

  // For element and hidden edges, the value in the slot is
  // a numeric index property of the hosting object, rather
  // than a pointer pointing to a string table.
  get is_index(): boolean {
    const type = this.type;
    return type === 'element' || type === 'hidden';
  }

  get name_or_index(): number | string {
    const heapSnapshot = this.heapSnapshot;
    const edgeValues = heapSnapshot.snapshot.edges;
    const edgeFieldsCount = heapSnapshot._edgeFieldsCount;
    const idx =
      edgeValues[
        this.idx * edgeFieldsCount + heapSnapshot._edgeNameOrIndexOffset
      ];
    if (this.is_index) {
      return idx;
    }
    return this.heapSnapshot.snapshot.strings[idx];
  }

  get to_node(): number {
    const heapSnapshot = this.heapSnapshot;
    const edgeValues = heapSnapshot.snapshot.edges;
    const edgeFieldsCount = heapSnapshot._edgeFieldsCount;
    const toNodeIdx =
      edgeValues[this.idx * edgeFieldsCount + heapSnapshot._edgeToNodeOffset];
    const nodeFieldsCount = heapSnapshot._nodeFieldsCount;
    if (toNodeIdx % nodeFieldsCount) {
      throwError(new Error('invalid idx: ' + this.idx));
    }
    return toNodeIdx / nodeFieldsCount;
  }

  get toNode(): HeapNode {
    return new HeapNode(this.heapSnapshot, this.to_node);
  }

  get fromNode(): HeapNode {
    const heapSnapshot = this.heapSnapshot;
    const edgeIndex2SrcNodeIndex = heapSnapshot._edgeIndex2SrcNodeIndex;
    const srcNodeIdx = edgeIndex2SrcNodeIndex[this.idx];
    return new HeapNode(heapSnapshot, srcNodeIdx);
  }
}

class HeapLocation implements IHeapLocation {
  constructor(private heapSnapshot: HeapSnapshot, private idx: number) {}

  get snapshot(): HeapSnapshot {
    return this.heapSnapshot;
  }

  get script_id(): number {
    const heapSnapshot = this.heapSnapshot;
    const locations = heapSnapshot.snapshot.locations;
    const locationFieldsCount = heapSnapshot._locationFieldsCount;
    return locations[
      this.idx * locationFieldsCount + heapSnapshot._locationScriptIdOffset
    ];
  }

  get line(): number {
    const heapSnapshot = this.heapSnapshot;
    const locations = heapSnapshot.snapshot.locations;
    const locationFieldsCount = heapSnapshot._locationFieldsCount;
    return locations[
      this.idx * locationFieldsCount + heapSnapshot._locationLineOffset
    ];
  }

  get column(): number {
    const heapSnapshot = this.heapSnapshot;
    const locations = heapSnapshot.snapshot.locations;
    const locationFieldsCount = heapSnapshot._locationFieldsCount;
    return locations[
      this.idx * locationFieldsCount + heapSnapshot._locationColumnOffset
    ];
  }
}

const NodeDetachState = {
  Unknown: 0,
  Attached: 1,
  Detached: 2,
};

const EMPTY_UINT8_ARRAY = new Uint8Array(0);
const EMPTY_UINT32_ARRAY = new Uint32Array(0);

class HeapSnapshot implements IHeapSnapshot {
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
      get(idx: number): IHeapNode {
        return new HeapNode(self, idx);
      },
      forEach(cb) {
        for (let i = 0; i < this.length; i++) {
          const ret = cb(this.get(i), i);
          if (ret === false) {
            break;
          }
        }
      },
      forEachTraceable(cb) {
        for (let i = 0; i < this.length; i++) {
          const node = this.get(i);
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
      get(idx) {
        return new HeapEdge(self, idx);
      },
      forEach(cb) {
        for (let i = 0; i < this.length; i++) {
          const ret = cb(this.get(i), i);
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
    const ref = table.findReference(
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

// ----------- utility and parsing functions -----------

function getSnapshotMetaData(content: string) {
  function getSignatureIndex(signature: string): number {
    const idx = content.indexOf(signature);
    if (idx < 0) {
      throw 'heap parsing: meta data parsing error';
    }
    return idx;
  }
  const startSignature = '"snapshot":';
  const startIdx = getSignatureIndex(startSignature) + startSignature.length;
  const endSignature = '"nodes":';
  const endIdx = getSignatureIndex(endSignature);
  const metaContent = content.slice(startIdx, endIdx).trim().slice(0, -1);
  return JSON.parse(metaContent);
}

const nums = Object.create(null);
for (let i = 0; i < 10; i++) {
  nums[`${i}`] = i;
}

async function loadSnapshotMetaDataFromFile(
  file: string,
): Promise<HeapSnapshotInfo> {
  const content = await stringLoader.readFile(file, {
    startSignature: '"snapshot":',
    endSignature: '"nodes":',
    inclusive: true,
  });
  return getSnapshotMetaData(content);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function getNodeIds(file: string, _options = {}): Promise<Set<number>> {
  const snapshotInfo = await loadSnapshotMetaDataFromFile(file);
  const nodes = await stringLoader.readFileAndExtractTypedArray(file, 'nodes');
  const ids: Set<number> = new Set();
  const nodeFields = snapshotInfo.meta.node_fields;
  const nodeFieldCount = nodeFields.length;
  const idOffset = nodeFields.indexOf('id');
  let valueIndex = 0;
  while (valueIndex < nodes.length) {
    ids.add(nodes[valueIndex + idOffset]);
    valueIndex += nodeFieldCount;
  }
  return ids;
}

async function parseFile(file: string): Promise<RawHeapSnapshot> {
  const [nodes, edges, locations, content] = await Promise.all([
    stringLoader.readFileAndExtractTypedArray(file, 'nodes'),
    stringLoader.readFileAndExtractTypedArray(file, 'edges'),
    stringLoader.readFileAndExtractTypedArray(file, 'locations'),
    stringLoader.readFileAndExcludeTypedArray(file, [
      'nodes',
      'edges',
      'locations',
    ]),
  ]);

  const snapshot = JSON.parse(content);
  snapshot.nodes = nodes;
  snapshot.edges = edges;
  snapshot.locations = locations;
  return snapshot;
}

// auto detect and set JS snapshot's engine type
function identifyAndSetEngine(snapshot: HeapSnapshot): void {
  if (config.specifiedEngine) {
    if (config.verbose) {
      info.lowLevel(
        `JS snapshot engine is manually set to be ${config.jsEngine}`,
      );
    }
    return; // skip if engine type is manually set
  }

  info.overwrite('identifying snapshot engine...');
  let engine = 'v8';
  snapshot.nodes.forEach(node => {
    if (node.type === 'object' && node.name.startsWith('Object(')) {
      engine = 'hermes';
      return false;
    }
  });

  if (config.verbose) {
    info.lowLevel(`detect and set JS snapshot engine: ${engine}`);
  }
  config.jsEngine = engine;
}

async function parse(file: string, options = {}): Promise<HeapSnapshot> {
  const snapshot = await parseFile(file);
  const ret = new HeapSnapshot(snapshot, options);
  identifyAndSetEngine(ret);
  return ret;
}

export default {
  HeapNode,
  HeapEdge,
  HeapSnapshot,
  HeapLocation,
  getNodeIds,
  parse,
};
