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

import type {IHeapStringNode} from '../Types';
import type HeapSnapshot from './HeapSnapshot';

import HeapNode from './HeapNode';
import {throwError} from './HeapUtils';

export default class HeapStringNode
  extends HeapNode
  implements IHeapStringNode
{
  constructor(heapSnapshot: HeapSnapshot, idx: number) {
    super(heapSnapshot, idx);
  }

  get stringValue(): string {
    const type = this.type;
    if (type === 'concatenated string') {
      const firstNode = this.getReferenceNode('first')?.toStringNode();
      const secondNode = this.getReferenceNode('second')?.toStringNode();
      if (firstNode == null || secondNode == null) {
        throw throwError(new Error('broken concatenated string'));
      }
      return firstNode.stringValue + secondNode.stringValue;
    }

    if (type === 'sliced string') {
      const parentNode = this.getReferenceNode('parent')?.toStringNode();
      if (parentNode == null) {
        throw throwError(new Error('broken sliced string'));
      }
      return parentNode.stringValue;
    }

    return this.name;
  }
}
