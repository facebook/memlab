/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @lightSyntaxTransform
 * @oncall web_perf_infra
 */

'use strict';

import type {AnyRecord, AnyValue, IHeapEdge} from '../Types';
import type HeapSnapshot from './HeapSnapshot';

import {throwError} from './HeapUtils';
import HeapNode from './HeapNode';

export default class HeapEdge implements IHeapEdge {
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

  getJSONifyableObject(): AnyRecord {
    return {
      name_or_index: this.name_or_index,
      type: this.type,
      edgeIndex: this.edgeIndex,
      toNode: this.toNode.getJSONifyableObject(),
      fromNode: this.fromNode.getJSONifyableObject(),
    };
  }

  toJSONString(...args: Array<AnyValue>): string {
    const rep = this.getJSONifyableObject();
    return JSON.stringify(rep, ...args);
  }
}
