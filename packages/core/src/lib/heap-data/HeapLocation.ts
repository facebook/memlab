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
  AnyRecord,
  AnyValue,
  IHeapLocation,
  IHeapNode,
  Nullable,
} from '../Types';
import type HeapSnapshot from './HeapSnapshot';
import type HeapNode from './HeapNode';

export default class HeapLocation implements IHeapLocation {
  constructor(
    private heapSnapshot: HeapSnapshot,
    private idx: number,
  ) {}

  get snapshot(): HeapSnapshot {
    return this.heapSnapshot;
  }

  get node(): Nullable<IHeapNode> {
    const heapSnapshot = this.heapSnapshot;
    const locations = heapSnapshot.snapshot.locations;
    const locationFieldsCount = heapSnapshot._locationFieldsCount;
    const objectIndex =
      locations[
        this.idx * locationFieldsCount + heapSnapshot._locationObjectIndexOffset
      ];
    return heapSnapshot.nodes.get(objectIndex);
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

  getJSONifyableObject(): AnyRecord {
    const node = this.node;
    const jsonNode =
      node == null ? null : (node as HeapNode).getJSONifyableObject();
    return {
      node: jsonNode,
      script_id: this.script_id,
      line: this.line,
      column: this.column,
    };
  }

  toJSONString(...args: Array<AnyValue>): string {
    const rep = this.getJSONifyableObject();
    return JSON.stringify(rep, ...args);
  }
}
