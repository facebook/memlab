/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {config, ErrorHandling} from '@memlab/core';
import {
  alignTextInBlock,
  argsToString,
  filterAndGetUndefinedArgs,
  getBlankSpaceString,
} from '../../lib/CLIUtils';

beforeEach(() => {
  config.isTest = true;
  config.errorHandling = ErrorHandling.Throw;
});

test('argsToString renders options as command-line flags', () => {
  expect(argsToString({})).toBe('');
  // positional arguments are skipped
  expect(argsToString({_: ['run'], app: 'comet'})).toBe('--app=comet');
  // `true` is a bare flag, other values are `--name=value`
  expect(argsToString({verbose: true, off: false, n: 3})).toBe(
    '--verbose --off=false --n=3',
  );
  // an array repeats the flag once per value
  expect(argsToString({tag: ['x', 'y']})).toBe('--tag=x --tag=y');
  // values with whitespace are quoted, and their own quotes escaped
  expect(argsToString({'work-dir': '/tmp/a b'})).toBe('--work-dir="/tmp/a b"');
  expect(argsToString({q: 'say "hi" now'})).toBe('--q="say \\"hi\\" now"');
  expect(argsToString({q: 'no"space'})).toBe('--q=no"space');
});

test('filterAndGetUndefinedArgs keeps only options memlab does not define', () => {
  const rest = filterAndGetUndefinedArgs({
    _: ['x'],
    app: 'comet',
    'work-dir': '/tmp',
    custom: '1',
    'my-flag': true,
  });
  expect(rest).toEqual({custom: '1', 'my-flag': true});
  expect(Object.getPrototypeOf(rest)).toBe(null);
});

test('getBlankSpaceString', () => {
  expect(getBlankSpaceString(0)).toBe('');
  expect(getBlankSpaceString(3)).toBe('   ');
});

test('alignTextInBlock indents and wraps text to the line length', () => {
  const lines = (text: string, leftIndent: number, lineLength: number) =>
    alignTextInBlock(text, {leftIndent, lineLength})
      .split('\n')
      .map(line => line.trimEnd());

  expect(lines('short', 2, 20)).toEqual(['  short']);
  // existing line breaks are kept, and every line is indented
  expect(lines('line one\nline two', 1, 40)).toEqual([
    ' line one',
    ' line two',
  ]);
  // long lines break at a space, never inside a word
  const wrapped = lines('the quick brown fox jumps over the lazy dog', 2, 20);
  expect(wrapped).toEqual([
    '  the quick brown',
    '  fox jumps over the',
    '  lazy dog',
  ]);
  for (const line of wrapped) {
    expect(line.length).toBeLessThanOrEqual(20);
  }
  // punctuation is also a break point
  expect(lines('call(foo,bar) and more text here', 0, 12)).toEqual([
    'call(foo,',
    'bar) and',
    'more text',
    'here',
  ]);
  // a word longer than the line is cut at the line length
  expect(lines('a'.repeat(25), 0, 10)).toEqual([
    'a'.repeat(10),
    'a'.repeat(10),
    'a'.repeat(5),
  ]);
});

test('alignTextInBlock rejects an indent that leaves no room for text', () => {
  expect(() =>
    alignTextInBlock('x', {leftIndent: 20, lineLength: 20}),
  ).toThrow();
  expect(() =>
    alignTextInBlock('x', {leftIndent: -1, lineLength: 20}),
  ).toThrow();
});
