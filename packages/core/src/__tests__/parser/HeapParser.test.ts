/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {AnyValue, IHeapNode, IHeapSnapshot} from '../../lib/Types';
import config from '../../lib/Config';
import utils from '../../lib/Utils';
import {isExpectedSnapshot} from './utils/HeapParserTestUtils';

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
  'Capture inserted object',
  async () => {
    const leakInjector = () => {
      class TestObject {
        public arr1 = [1, 2, 3];
        public arr2 = ['1', '2', '3'];
      }
      window.injected = new TestObject();
    };

    const checker = (snapshot: IHeapSnapshot) => {
      let detected = false;
      snapshot.nodes.forEach((node: IHeapNode) => {
        if (node.name === 'TestObject' && node.type === 'object') {
          detected = true;
        }
      });
      return detected;
    };

    await isExpectedSnapshot(leakInjector, checker);
  },
  timeout,
);

test(
  'Does not capture transcient object',
  async () => {
    const leakInjector = () => {
      class TestObject {
        public arr1 = [1, 2, 3];
        public arr2 = ['1', '2', '3'];
      }
      window.injected = new TestObject();
      window.injected = null;
    };

    const checker = (snapshot: IHeapSnapshot) => {
      let detected = false;
      snapshot.nodes.forEach((node: IHeapNode) => {
        if (node.name === 'TestObject' && node.type === 'object') {
          detected = true;
        }
      });
      return !detected;
    };

    await isExpectedSnapshot(leakInjector, checker);
  },
  timeout,
);

test(
  'Capture numeric value',
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
