/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @lightSyntaxTransform
 * @oncall memory_lab
 */

'use strict';

import type {
  IHeapNode,
  IHeapEdge,
  Nullable,
  EdgeIterationCallback,
  Predicator,
  IHeapStringNode,
  AnyRecord,
  AnyValue,
} from '../Types';
import type HeapSnapshot from './HeapSnapshot';

import {NodeDetachState, throwError} from './HeapUtils';
import HeapEdge from './HeapEdge';
import HeapLocation from './HeapLocation';

export function isHeapStringType(type: string): boolean {
  return ['string', 'sliced string', 'concatenated string'].includes(type);
}

export default class HeapNode implements IHeapNode {
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

  findAnyReference(predicate: Predicator<IHeapEdge>): Nullable<IHeapEdge> {
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

  findAnyReferrerNode(predicate: Predicator<IHeapNode>): Nullable<IHeapNode> {
    let found: Nullable<IHeapNode> = null;
    this.forEachReferrer((edge: IHeapEdge) => {
      const node = edge.fromNode;
      if (predicate(node)) {
        found = node;
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

  findReferrerNodes(predicate: Predicator<IHeapNode>): IHeapNode[] {
    const ret: IHeapNode[] = [];
    this.forEachReferrer((edge: IHeapEdge) => {
      const node = edge.fromNode;
      if (predicate(node)) {
        ret.push(node);
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

  get numOfReferrers(): number {
    const heapSnapshot = this.heapSnapshot;
    const firstRetainerIndex = heapSnapshot._firstRetainerIndex;
    const beginIdx = firstRetainerIndex[this.idx];
    const endIdx = firstRetainerIndex[this.idx + 1];
    return endIdx - beginIdx;
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

  get hasPathEdge(): boolean {
    const heapSnapshot = this.heapSnapshot;
    return heapSnapshot._nodeIdxHasPathEdge[this.idx] !== 0;
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
    const bigUintSize = this.heapSnapshot._nodeIdx2RetainedSize[this.idx];
    return Number(bigUintSize);
  }

  set retainedSize(size: number) {
    const heapSnapshot = this.heapSnapshot;
    const bigUintSize = BigInt(Math.floor(size));
    heapSnapshot._nodeIdx2RetainedSize[this.idx] = bigUintSize;
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
    return locationIdx == heapSnapshot._locationCount // no location mapping
      ? null
      : new HeapLocation(heapSnapshot, locationIdx);
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

  get isString(): boolean {
    return isHeapStringType(this.type);
  }

  toStringNode(): Nullable<IHeapStringNode> {
    return this.isString
      ? new HeapStringNode(this.heapSnapshot, this.idx)
      : null;
  }

  getJSONifyableObject(): AnyRecord {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      self_size: this.self_size,
      trace_node_id: this.trace_node_id,
      nodeIndex: this.nodeIndex,
      outGoingEdgeCount: this.edge_count,
      incomingEdgeCount: this.numOfReferrers,
      contructorName: this.constructor.name,
    };
  }

  toJSONString(...args: Array<AnyValue>): string {
    const rep = this.getJSONifyableObject();
    return JSON.stringify(rep, ...args);
  }
}

// HeapStringNode has to be imported after exporting HeapNode
// since HeapStringNode imports and extends HeapNode
import HeapStringNode from './HeapStringNode';
