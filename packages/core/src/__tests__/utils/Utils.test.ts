/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
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

test('Check getNumberAtPercentile', async () => {
  expect(utils.getNumberAtPercentile([], 80)).toBe(0);
  expect(utils.getNumberAtPercentile([10, 20, 30, 40, 50], 100)).toBe(50);
  expect(utils.getNumberAtPercentile([7], 100)).toBe(7);
  expect(utils.getNumberAtPercentile([10, 20, 30, 40, 50], 0)).toBe(10);
  expect(utils.getNumberAtPercentile([10, 20, 30, 40, 50], 80)).toBe(50);
  expect(utils.getNumberAtPercentile([5, 3, 1, 4, 2], 50)).toBe(3.5);
  // out-of-range percentiles are clamped rather than returning undefined/NaN
  expect(utils.getNumberAtPercentile([10, 20, 30, 40, 50], -10)).toBe(10);
  expect(utils.getNumberAtPercentile([10, 20, 30, 40, 50], 120)).toBe(50);
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

test('Check getReadablePercent', async () => {
  expect(utils.getReadablePercent(0)).toBe('0%');
  expect(utils.getReadablePercent(0.5)).toBe('50%');
  expect(utils.getReadablePercent(1)).toBe('100%');
  expect(utils.getReadablePercent(1.5)).toBe('150%');
  expect(utils.getReadablePercent(-0.25)).toBe('-25%');
  // at most two decimals, and trailing zeros are dropped
  expect(utils.getReadablePercent(0.123)).toBe('12.3%');
  expect(utils.getReadablePercent(0.1234)).toBe('12.34%');
  expect(utils.getReadablePercent(0.12344)).toBe('12.34%');
  expect(utils.getReadablePercent(0.00001)).toBe('0%');
  expect(utils.getReadablePercent(NaN)).toBe('NaN%');
});

test('Check getReadableTime', async () => {
  expect(utils.getReadableTime(0)).toBe('0ms');
  expect(utils.getReadableTime(999)).toBe('999ms');
  expect(utils.getReadableTime(1000)).toBe('1s');
  expect(utils.getReadableTime(1500)).toBe('1.5s');
  // one decimal, truncated rather than rounded, so 59.99s stays in seconds
  expect(utils.getReadableTime(59999)).toBe('59.9s');
  expect(utils.getReadableTime(60 * 1000)).toBe('1min');
  expect(utils.getReadableTime(90 * 1000)).toBe('1.5min');
  expect(utils.getReadableTime(60 * 60 * 1000)).toBe('1hr');
  expect(utils.getReadableTime(90 * 60 * 1000)).toBe('1.5hr');
  expect(utils.getReadableTime(60 * 60 * 60 * 1000)).toBe('2.5 days');
});

test('Check camelCaseToReadableString', async () => {
  expect(utils.camelCaseToReadableString('fooBarBaz')).toBe('foo bar baz');
  expect(utils.camelCaseToReadableString('FooBar')).toBe('foo bar');
  expect(utils.camelCaseToReadableString('  leadingSpace ')).toBe(
    'leading space',
  );
  expect(utils.camelCaseToReadableString('already lower')).toBe(
    'already lower',
  );
  expect(utils.camelCaseToReadableString('')).toBe('');
  expect(
    utils.camelCaseToReadableString('fooBarBaz', {capitalizeFirstWord: true}),
  ).toBe('Foo bar baz');
  expect(utils.camelCaseToReadableString('', {capitalizeFirstWord: true})).toBe(
    '',
  );
});

test('Check convertCLIArgsToReadableCommand', async () => {
  expect(utils.convertCLIArgsToReadableCommand([])).toBe('');
  expect(utils.convertCLIArgsToReadableCommand(['memlab', 'run'])).toBe(
    'memlab run',
  );
  // arguments with whitespace are quoted
  expect(
    utils.convertCLIArgsToReadableCommand(['--scenario', '/tmp/a b.js']),
  ).toBe('--scenario "/tmp/a b.js"');
  // arguments already wrapped in escaped quotes are unescaped, not re-quoted
  expect(
    utils.convertCLIArgsToReadableCommand(['--work-dir', '\\"/tmp/x y\\"']),
  ).toBe('--work-dir "/tmp/x y"');
});
