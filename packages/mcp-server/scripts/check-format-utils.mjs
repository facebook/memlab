/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * Unit tests for the report formatters in utils.ts that every tool prints
 * through: sizes, counts, clamped labels, collapsed retainer runs and tables.
 *
 *   npm run build-pkg && npm run test-units
 *
 * Runs against the BUILT dist/, so it needs the package's dependencies
 * installed, the same as check-fixtures.mjs.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, '..', 'dist', 'utils.js');
if (!fs.existsSync(built)) {
  console.error('check-format-utils: dist/utils.js is missing; build first.');
  process.exit(1);
}
const {
  formatBytes,
  formatNumber,
  clampLabelTo,
  collapseRepeatedLabels,
  collapseRepeatedRuns,
  markdownTable,
} = await import(pathToFileURL(built).href);

test('formatBytes: binary steps with one decimal, and N/A for non-sizes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 ** 2), '1.0 MB');
  assert.equal(formatBytes(5.5 * 1024 ** 3), '5.5 GB');
  for (const bad of [-1, NaN, Infinity]) assert.equal(formatBytes(bad), 'N/A');
});

test('formatNumber: groups thousands the same way on every host', () => {
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(1_234_567), '1,234,567');
  assert.equal(formatNumber(-1234), '-1,234');
});

test('clampLabelTo: flattens whitespace and leaves short labels alone', () => {
  assert.equal(clampLabelTo('  a   b\n c ', 10), 'a b c');
  assert.equal(clampLabelTo('abcdefghij', 10), 'abcdefghij');
});

test('clampLabelTo: a cut label says how many characters it dropped', () => {
  assert.equal(clampLabelTo('abcdefghijkl', 10), 'abcdefghi… (+3 chars)');
  assert.equal(clampLabelTo('x'.repeat(2000), 10), 'xxxxxxxxx… (+1,991 chars)');
});

test('collapseRepeatedLabels: folds a run of 3+ into one label with a count', () => {
  assert.deepEqual(collapseRepeatedLabels(['A', 'B', 'B', 'B', 'C']), [
    'A',
    'B ×3',
    'C',
  ]);
  assert.deepEqual(collapseRepeatedLabels(['A', 'B', 'B', 'C']), [
    'A',
    'B',
    'B',
    'C',
  ]);
  assert.deepEqual(collapseRepeatedLabels(['A', 'B']), ['A', 'B']);
});

test('collapseRepeatedLabels: never folds the last label, the target', () => {
  assert.deepEqual(collapseRepeatedLabels(['B', 'B', 'B', 'B']), ['B ×3', 'B']);
  assert.deepEqual(collapseRepeatedLabels(['A', 'B', 'B', 'B', 'B', 'B']), [
    'A',
    'B ×4',
    'B',
  ]);
});

const step = (name, type = 'object') => ({id: 0, name, type});

test('collapseRepeatedRuns: folds same-name, same-type hops and keeps the target', () => {
  assert.deepEqual(
    collapseRepeatedRuns([
      step('Root'),
      step('Node'),
      step('Node'),
      step('Node'),
      step('Leaf'),
    ]),
    [step('Root'), {...step('Node'), repeatCount: 3}, step('Leaf')],
  );
  assert.deepEqual(
    collapseRepeatedRuns([
      step('Node'),
      step('Node'),
      step('Node'),
      step('Node'),
    ]),
    [{...step('Node'), repeatCount: 3}, step('Node')],
  );
});

test('collapseRepeatedRuns: a different type breaks the run', () => {
  const steps = [
    step('Node'),
    step('Node', 'closure'),
    step('Node'),
    step('X'),
  ];
  assert.deepEqual(collapseRepeatedRuns(steps), steps);
});

test('markdownTable: pads every column and right-aligns the ones asked for', () => {
  assert.equal(
    markdownTable(
      ['Name', 'Count'],
      [
        ['a', '1'],
        ['longer', '12,345'],
      ],
      new Set([1]),
    ),
    [
      '| Name   |  Count |',
      '|--------|-------:|',
      '| a      |      1 |',
      '| longer | 12,345 |',
    ].join('\n'),
  );
});

test('markdownTable: separators are at least three dashes, even for an empty header', () => {
  assert.equal(markdownTable(['N'], [['a']]), '| N |\n|---|\n| a |');
  assert.equal(markdownTable([''], [['']]), '|  |\n|---|\n|  |');
  assert.equal(markdownTable(['A', 'B'], []), '| A | B |\n|---|---|');
});
