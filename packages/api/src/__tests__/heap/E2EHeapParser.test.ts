/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {AnyValue, IHeapNode, IHeapSnapshot} from '@memlab/core';

import {config, utils} from '@memlab/core';
import {isExpectedSnapshot} from './lib/HeapParserTestUtils';

/* eslint-disable @typescript-eslint/ban-ts-comment */

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
  'Capture numeric value from heap in browser',
  async () => {
    const leakInjector = () => {
      class TestObject {
        public numProp = 0.1;
      }
      window.injected = new TestObject();
    };

    const checker = (snapshot: IHeapSnapshot) => {
      let detected = false;
      snapshot.nodes.forEach((node: IHeapNode) => {
        if (node.name !== 'TestObject' || node.type !== 'object') {
          return;
        }
        const refs = node.references;
        for (const ref of refs) {
          if (ref.name_or_index === 'numProp') {
            const node = ref.toNode;
            if (
              node.type === 'number' &&
              utils.getNumberNodeValue(node) === 0.1
            ) {
              detected = true;
            }
            break;
          }
        }
      });
      return detected;
    };

    await isExpectedSnapshot(leakInjector, checker);
  },
  timeout,
);
