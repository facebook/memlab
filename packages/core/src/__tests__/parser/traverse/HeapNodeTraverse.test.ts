/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {AnyValue, IHeapNode, IHeapSnapshot} from '../../../lib/Types';
import config from '../../../lib/Config';
import {takeNodeMinimalHeap} from '../../../lib/NodeHeap';

declare global {
  interface Window {
    injected: AnyValue;
  }
}

beforeEach(() => {
  config.isTest = true;
});

const timeout = 5 * 60 * 1000;

test(
  'Check getReference and getReferenceNode',
  async () => {
    class TestObject {
      public property1 = {property2: 'test'};
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const injected = new TestObject();

    const checker = (heap: IHeapSnapshot) => {
      let detected = false;
      heap.nodes.forEach((node: IHeapNode) => {
        if (node.name !== 'TestObject' || node.type !== 'object') {
          return;
        }

        // check testObject.property1 reference
        if (node.getReference('property1') == null) {
          return;
        }

        // check testObject.property1 reference with edge type
        if (node.getReference('property1', 'property') == null) {
          return;
        }

        // check testObject.property1 reference with edge type
        if (node.getReference('property1', 'internal') != null) {
          return;
        }

        // check testObject.property1 referenced node
        if (node.getReferenceNode('property1') == null) {
          return;
        }

        // check testObject.property1 referenced node with edge type
        if (node.getReferenceNode('property1', 'property') == null) {
          return;
        }

        // check testObject.property1 referenced node with edge type
        if (node.getReferenceNode('property1', 'internal') != null) {
          return;
        }

        // check testObject.property1.property2 referenced node
        const referencedNode = node.getReferenceNode('property1');
        if (referencedNode?.getReferenceNode('property2') == null) {
          return;
        }
        detected = true;
      });
      return detected;
    };

    const heap = await takeNodeMinimalHeap();
    expect(checker(heap)).toBe(true);
  },
  timeout,
);

test(
  'Check getReferrers and getReferrerNodes',
  async () => {
    const leakInjector = () => {
      const obj = {p1: {p2: {p3: 'test'}}};
      class TestObject {
        public prop = obj;
        private _p = obj;
      }
      return [new TestObject(), new TestObject()];
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const injected = leakInjector();

    const checker = (heap: IHeapSnapshot) => {
      const testObjects: IHeapNode[] = [];

      // get all TestObjects
      heap.nodes.forEach((node: IHeapNode) => {
        if (node.name === 'TestObject' && node.type === 'object') {
          testObjects.push(node);
        }
      });

      // there should be exactly 2 TestObjects
      if (testObjects.length !== 2) {
        return false;
      }

      // testObject.prop.p1.p2.p3 should be a string
      const strNode = testObjects[0]
        ?.getReferenceNode('prop')
        ?.getReferenceNode('p1')
        ?.getReferenceNode('p2')
        ?.getReferenceNode('p3');
      if (!strNode || strNode.type !== 'string') {
        return false;
      }

      // testObject.prop should have 2 referrering edges with name 'prop'
      let edges = testObjects[0].getReferenceNode('prop')?.getReferrers('prop');
      if (!edges || edges.length !== 2) {
        return false;
      }

      // testObject.prop should have 2 referrering edges with name '_p'
      edges = testObjects[0].getReferenceNode('_p')?.getReferrers('_p');
      if (!edges || edges.length !== 2) {
        return false;
      }

      // testObject.prop should have 2 unique referring nodes
      const nodes = testObjects[0]
        .getReferenceNode('prop')
        ?.getReferrerNodes('_p');
      if (!nodes || nodes.length !== 2) {
        return false;
      }

      // trace back to testObject from testObject.prop.p1.p2.p3
      const to = strNode
        .getReferrerNodes('p3')[0]
        ?.getReferrerNodes('p2')[0]
        ?.getReferrerNodes('p1')[0]
        ?.getReferrerNodes('prop')[0];
      if (!to || to.name !== 'TestObject') {
        return false;
      }
      if (!testObjects.some(o => o.id === to.id)) {
        return false;
      }

      return true;
    };

    const heap = await takeNodeMinimalHeap();
    expect(checker(heap)).toBe(true);
  },
  timeout,
);
