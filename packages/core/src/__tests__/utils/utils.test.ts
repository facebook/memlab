/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import config from '../../lib/Config';
import {IHeapEdge, IHeapNode} from '../../lib/Types';
import utils from '../../lib/Utils';

beforeEach(() => {
  config.isTest = true;
});

const strackTraceFrameNodeMock = {
  type: 'hidden',
  name: 'system / StackTraceFrame',
} as IHeapNode;
const oddBallNodeMock = {name: 'system / Oddball'} as IHeapNode;
const detachedFiberNodeMock = {
  type: 'object',
  name: 'Detached FiberNode',
} as IHeapNode;
const fiberNodeMock = {type: 'object', name: 'FiberNode'} as IHeapNode;
const weakMapEdgeMock = {
  type: 'internal',
  name_or_index:
    '4 / part of key Object @474899 -> value Object @474901 pair in WeakMap table @654951',
} as IHeapEdge;
const edgeMock = {
  type: 'property',
  name_or_index: 'intersectionObserver',
} as IHeapEdge;

test('Check getReadableBytes', async () => {
  expect(utils.getReadableBytes(0)).toBe('0 byte');
  expect(utils.getReadableBytes(1)).toBe('1 byte');
  expect(utils.getReadableBytes(2)).toBe('2 bytes');
  expect(utils.getReadableBytes(10)).toBe('10 bytes');
  expect(utils.getReadableBytes(1000)).toBe('1KB');
  expect(utils.getReadableBytes(1010)).toBe('1KB');
  expect(utils.getReadableBytes(1130)).toBe('1.1KB');
  expect(utils.getReadableBytes(1200000)).toBe('1.2MB');
  expect(utils.getReadableBytes(980000000)).toBe('980MB');
  expect(utils.getReadableBytes(2212312313)).toBe('2.2GB');
  expect(utils.getReadableBytes(5432212312313)).toBe('5.4TB');
});

test('Check isStackTraceFrame', async () => {
  expect(utils.isStackTraceFrame(strackTraceFrameNodeMock)).toBe(true);
  expect(utils.isStackTraceFrame(oddBallNodeMock)).toBe(false);
  expect(utils.isStackTraceFrame(detachedFiberNodeMock)).toBe(false);
  expect(utils.isStackTraceFrame(fiberNodeMock)).toBe(false);
});

test('Check isDetachedFiberNode', async () => {
  expect(utils.isDetachedFiberNode(detachedFiberNodeMock)).toBe(true);
  expect(utils.isDetachedFiberNode(fiberNodeMock)).toBe(false);
  expect(utils.isDetachedFiberNode(strackTraceFrameNodeMock)).toBe(false);
  expect(utils.isDetachedFiberNode(oddBallNodeMock)).toBe(false);
});

test('Check isFiberNode', async () => {
  expect(utils.isFiberNode(detachedFiberNodeMock)).toBe(true);
  expect(utils.isFiberNode(fiberNodeMock)).toBe(true);
  expect(utils.isFiberNode(strackTraceFrameNodeMock)).toBe(false);
  expect(utils.isFiberNode(oddBallNodeMock)).toBe(false);
});

test('Check isWeakMapEdge', async () => {
  expect(utils.isWeakMapEdge(weakMapEdgeMock)).toBe(true);
  expect(utils.isWeakMapEdge(edgeMock)).toBe(false);
});
