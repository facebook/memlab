/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @lightSyntaxTransform
 * @oncall ws_labs
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
      // sliced string in heap snapshot doesn't include
      // the start index and the end index, so this may be inaccurate
      return parentNode.stringValue;
    }

    return this.name;
  }
}
