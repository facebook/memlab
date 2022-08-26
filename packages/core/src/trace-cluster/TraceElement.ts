/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import type {
  EdgeIterationCallback,
  IHeapEdge,
  IHeapLocation,
  IHeapNode,
  IHeapSnapshot,
  IHeapStringNode,
  Nullable,
} from '../lib/Types';

import utils from '../lib/Utils';

export class NodeRecord implements IHeapNode {
  kind: string;
  name: string;
  type: string;
  id: number;
  is_detached: boolean;
  detachState: number;
  attributes: number;
  self_size: number;
  edge_count: number;
  trace_node_id: number;
  nodeIndex: number;
  retainedSize: number;
  highlight?: boolean;

  markAsDetached(): void {
    throw new Error('NodeRecord.markAsDetached not callable.');
  }
  get isString(): boolean {
    return utils.isStringNode(this);
  }
  set isString(b: boolean) {
    throw new Error('NodeRecord.string cannot be assigned');
  }
  set snapshot(s: IHeapSnapshot) {
    throw new Error('NodeRecord.snapshot cannot be assigned.');
  }
  get snapshot(): IHeapSnapshot {
    throw new Error('NodeRecord.snapshot cannot be read.');
  }
  set references(r: IHeapEdge[]) {
    throw new Error('NodeRecord.references cannot be assigned');
  }
  get references(): IHeapEdge[] {
    throw new Error('NodeRecord.references cannot be read');
  }
  forEachReference(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _callback: EdgeIterationCallback,
  ): void {
    throw new Error('NodeRecord.forEachReference is not implemented');
  }
  set referrers(r: IHeapEdge[]) {
    throw new Error('NodeRecord.referrers cannot be assigned');
  }
  get referrers(): IHeapEdge[] {
    throw new Error('NodeRecord.referrers cannot be read');
  }
  toStringNode(): IHeapStringNode {
    throw new Error('NodeRecord.toStringNode is not implemented');
  }
  forEachReferrer(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _callback: EdgeIterationCallback,
  ): void {
    throw new Error('NodeRecord.forEachReferrer is not implemented');
  }
  findAnyReference(): Nullable<IHeapEdge> {
    throw new Error('NodeRecord.findAnyReference is not implemented');
  }
  findAnyReferrer(): Nullable<IHeapEdge> {
    throw new Error('NodeRecord.findAnyReferrer is not implemented');
  }
  findReferrers(): IHeapEdge[] {
    throw new Error('NodeRecord.findReferrers is not implemented');
  }
  set hasPathEdge(f: boolean) {
    throw new Error('NodeRecord.hasPathEdge cannot be assigned');
  }
  get hasPathEdge(): boolean {
    throw new Error('NodeRecord.hasPathEdge cannot be read');
  }
  set pathEdge(r: IHeapEdge) {
    throw new Error('NodeRecord.pathEdge cannot be assigned');
  }
  get pathEdge(): IHeapEdge {
    throw new Error('NodeRecord.pathEdge cannot be read');
  }
  set dominatorNode(r: IHeapNode) {
    throw new Error('NodeRecord.pathEdge cannot be assigned');
  }
  get dominatorNode(): IHeapNode {
    throw new Error('NodeRecord.pathEdge cannot be read');
  }
  set location(r: IHeapLocation) {
    throw new Error('NodeRecord.location cannot be assigned');
  }
  get location(): IHeapLocation {
    throw new Error('NodeRecord.location cannot be read');
  }

  getReference(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _edgeName: string | number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _edgeType?: string,
  ): Nullable<IHeapEdge> {
    throw new Error('NodeRecord.getReference is not implemented');
  }

  getReferenceNode(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _edgeName: string | number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _edgeType?: string,
  ): Nullable<IHeapNode> {
    throw new Error('NodeRecord.getReferenceNode is not implemented');
  }

  getAnyReferrer(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _edgeName: string | number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _edgeType?: string,
  ): Nullable<IHeapEdge> {
    throw new Error('NodeRecord.getReferrer is not implemented');
  }

  getAnyReferrerNode(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _edgeName: string | number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _edgeType?: string,
  ): Nullable<IHeapNode> {
    throw new Error('NodeRecord.getReferrerNode is not implemented');
  }

  getReferrers(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _edgeName: string | number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _edgeType?: string,
  ): IHeapEdge[] {
    throw new Error('NodeRecord.getReferrers is not implemented');
  }

  getReferrerNodes(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _edgeName: string | number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _edgeType?: string,
  ): IHeapNode[] {
    throw new Error('NodeRecord.getReferrerNodes is not implemented');
  }

  constructor(node: IHeapNode) {
    this.kind = 'node';
    this.name = this.extraceNodeName(node);
    this.type = node.type;
    this.id = node.id;
    this.is_detached = node.is_detached;
    this.detachState = node.detachState;
    this.attributes = node.attributes;
    this.self_size = node.self_size;
    this.edge_count = node.edge_count;
    this.trace_node_id = node.trace_node_id;
    this.nodeIndex = node.nodeIndex;
    this.retainedSize = node.retainedSize;
    this.highlight = node.highlight;
  }

  private extraceNodeName(node: IHeapNode): string {
    // deserialized node may not have snapshot info
    if (!node.snapshot || !utils.isFiberNode(node)) {
      return node.name;
    }
    return utils.extractFiberNodeInfo(node);
  }
}

export class EdgeRecord implements IHeapEdge {
  kind: string;
  name_or_index: string | number;
  type: string;
  edgeIndex: number;
  is_index: boolean;
  to_node: number;

  constructor(edge: IHeapEdge) {
    this.kind = 'edge';
    this.name_or_index = edge.name_or_index;
    this.type = edge.type;
    this.edgeIndex = edge.edgeIndex;
    this.is_index = edge.is_index;
    this.to_node = edge.to_node;
  }

  set snapshot(s: IHeapSnapshot) {
    throw new Error('EdgeRecord.snapshot cannot be assigned.');
  }
  get snapshot(): IHeapSnapshot {
    throw new Error('EdgeRecord.snapshot cannot be read.');
  }
  set toNode(s: IHeapNode) {
    throw new Error('EdgeRecord.toNode cannot be assigned.');
  }
  get toNode(): IHeapNode {
    throw new Error('EdgeRecord.toNode cannot be read.');
  }
  set fromNode(s: IHeapNode) {
    throw new Error('EdgeRecord.fromNode cannot be assigned.');
  }
  get fromNode(): IHeapNode {
    throw new Error('EdgeRecord.fromNode cannot be read.');
  }
}

export type NormalizedTraceElement = NodeRecord | EdgeRecord;
