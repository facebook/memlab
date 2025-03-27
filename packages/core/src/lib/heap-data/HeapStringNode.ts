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

import type {AnyRecord, IHeapStringNode} from '../Types';
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
    const stack: IHeapStringNode[] = [this];
    let ret = '';
    while (stack.length > 0) {
      const node = stack.pop() as HeapStringNode;
      const type = node.type;
      if (type === 'concatenated string') {
        const firstNode = node.getReferenceNode('first')?.toStringNode();
        const secondNode = node.getReferenceNode('second')?.toStringNode();
        if (firstNode == null || secondNode == null) {
          throw throwError(new Error('broken concatenated string'));
        }
        stack.push(secondNode);
        stack.push(firstNode);
        continue;
      }

      if (type === 'sliced string') {
        const parentNode = node.getReferenceNode('parent')?.toStringNode();
        if (parentNode == null) {
          throw throwError(new Error('broken sliced string'));
        }
        // sliced string in heap snapshot doesn't include
        // the start index and the end index, so this may be inaccurate
        ret += `<sliced string of @${parentNode.id}>`;
        continue;
      }

      ret += node.name;
    }
    return ret;
  }

  getJSONifyableObject(): AnyRecord {
    const rep = super.getJSONifyableObject();
    rep.stringValue = this.stringValue;
    return rep;
  }
}
