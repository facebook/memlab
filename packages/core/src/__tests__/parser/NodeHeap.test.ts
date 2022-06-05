/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type { AnyValue, Nullable } from '../../lib/Types';
import config from '../../lib/Config';
import { getCurrentNodeHeap } from '../../lib/NodeHeap';

beforeEach(() => {
  config.isTest = true;
});

const timeout = 5 * 60 * 1000;

test(
  'Capture current node heap snapshot',
  async () => {
    const object = { 'memlab-test-heap-property': 'memlab-test-heap-value' };
    const heap = await getCurrentNodeHeap();
    expect(heap.hasObjectWithPropertyName('memlab-test-heap-property')).toBe(
      true
    );
  },
  timeout
);

test(
  'Nullified Object should not exist in heap',
  async () => {
    let object: Nullable<{ 'memlab-test-heap-property': string }> = {
      'memlab-test-heap-property': 'memlab-test-heap-value',
    };
    object = null;
    const heap = await getCurrentNodeHeap();
    expect(heap.hasObjectWithPropertyName('memlab-test-heap-property')).toBe(
      false
    );
  },
  timeout
);

test(
  'Strongly referenced object should exist in heap',
  async () => {
    class TestClass2 {
      public p1 = 'memlab-property-value-3';
    }
    class TestClass1 {
      public p: 'memlab-property-value-1';
      public p2: 'memlab-property-value-2';
      public set: Set<TestClass2>;
      constructor(o: TestClass2) {
        this.set = new Set();
        this.set.add(o);
      }
    }
    function buildTest() {
      return new TestClass1(new TestClass2());
    }
    const object = buildTest();
    const heap = await getCurrentNodeHeap();
    expect(heap.hasObjectWithClassName('TestClass1')).toBe(true);
    expect(heap.hasObjectWithClassName('TestClass2')).toBe(true);
  },
  timeout
);

test(
  'Weakly referenced object should not exist in heap',
  async () => {
    class TestClass4 {
      public p1 = 'memlab-property-value-3';
    }
    class TestClass3 {
      public p: 'memlab-property-value-1';
      public p2: 'memlab-property-value-2';
      public set: WeakSet<TestClass4>;
      constructor(o: TestClass4) {
        this.set = new WeakSet();
        this.set.add(o);
      }
    }
    function buildTest() {
      return new TestClass3(new TestClass4());
    }
    const object = buildTest();
    const heap = await getCurrentNodeHeap();
    expect(heap.hasObjectWithClassName('TestClass3')).toBe(true);
    expect(heap.hasObjectWithClassName('TestClass4')).toBe(false);
  },
  timeout
);


test(
  'Check annotated objects',
  async () => {
    const o1: AnyValue = {};
    let o2: AnyValue = {};
    o1.__memlab_tag = 'memlab-mark-1';
    o2.__memlab_tag = 'memlab-mark-2';
    o2 = null;
    const heap = await getCurrentNodeHeap();
    expect(heap.hasObjectWithTag('memlab-mark-1')).toBe(true);
    expect(heap.hasObjectWithTag('memlab-mark-2')).toBe(false);
  },
  timeout
);
