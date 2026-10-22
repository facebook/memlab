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
 * Unit tests for the paging contract every ranked list shares.
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
const built = path.join(here, '..', 'dist', 'pagination.js');
if (!fs.existsSync(built)) {
  console.error(
    'check-pagination: dist/pagination.js is missing; build first.',
  );
  process.exit(1);
}
const {paginate, pageFooter, pageLines, openPageFooter, offsetParam} =
  await import(pathToFileURL(built).href);

const rows = Array.from({length: 45}, (_, i) => i);

test('paginate: pages cover every row once, in order', () => {
  const seen = [];
  let offset = 0;
  // Bounded, so a next offset that never runs out fails instead of hanging.
  for (let calls = 0; offset != null && calls < 10; calls++) {
    const page = paginate(rows, offset, 20);
    seen.push(...page.items);
    offset = page.nextOffset;
  }
  assert.equal(offset, null);
  assert.deepEqual(seen, rows);
});

test('paginate: the last page is short and has no next offset', () => {
  const page = paginate(rows, 40, 20);
  assert.deepEqual(page.items, [40, 41, 42, 43, 44]);
  assert.equal(page.offset, 40);
  assert.equal(page.total, 45);
  assert.equal(page.nextOffset, null);
  assert.equal(page.notice, undefined);
});

test('paginate: an offset past the end shows the first page and says so', () => {
  const page = paginate(rows, 45, 20);
  assert.equal(page.offset, 0);
  assert.deepEqual(page.items, rows.slice(0, 20));
  assert.equal(
    page.notice,
    '`offset` 45 is past the last of 45; showing the first page.',
  );
});

test('paginate: offsets and page sizes are floored and clamped', () => {
  assert.deepEqual(paginate(rows, -3, 10).items, rows.slice(0, 10));
  assert.deepEqual(paginate(rows, 2.7, 0).items, [2]);
  assert.equal(paginate(rows, 0, 10.9).pageSize, 10);
  assert.deepEqual(paginate(rows, undefined, 5).items, [0, 1, 2, 3, 4]);
});

test('paginate: an empty list is one empty page', () => {
  const page = paginate([], 0, 20);
  assert.deepEqual(page.items, []);
  assert.equal(page.total, 0);
  assert.equal(page.nextOffset, null);
  assert.equal(page.notice, undefined);
});

test('paginate: a typed array pages into a plain array of just the page', () => {
  const page = paginate(new Float64Array([1, 2, 3, 4]), 1, 2);
  assert.ok(Array.isArray(page.items));
  assert.deepEqual(page.items, [2, 3]);
  assert.equal(page.nextOffset, 3);
});

test('pageFooter: on the grid, names the page and the next offset', () => {
  assert.equal(
    pageFooter(paginate(rows, 0, 20), 'rows'),
    'Showing 1–20 of 45 rows (page 1 of 3). Next page: `offset: 20`.',
  );
  assert.equal(
    pageFooter(paginate(rows, 40, 20)),
    'Showing 41–45 of 45 (page 3 of 3).',
  );
});

test('pageFooter: off the grid, drops the page number', () => {
  assert.equal(
    pageFooter(paginate(rows, 5, 20)),
    'Showing 6–25 of 45. Next page: `offset: 25`.',
  );
});

test('pageFooter: a single page has no page number, and nothing is empty', () => {
  assert.equal(
    pageFooter(paginate(rows.slice(0, 5), 0, 20)),
    'Showing 1–5 of 5.',
  );
  assert.equal(pageFooter(paginate([], 0, 20)), '');
});

test('pageFooter: large counts are grouped', () => {
  const big = Array.from({length: 12_345}, (_, i) => i);
  assert.equal(
    pageFooter(paginate(big, 12_000, 1000)),
    'Showing 12,001–12,345 of 12,345 (page 13 of 13).',
  );
});

test('pageLines: the out-of-range notice comes before the footer', () => {
  assert.deepEqual(pageLines(paginate(rows, 99, 20)), [
    '`offset` 99 is past the last of 45; showing the first page.',
    'Showing 1–20 of 45 (page 1 of 3). Next page: `offset: 20`.',
  ]);
  assert.deepEqual(pageLines(paginate([], 0, 20)), []);
});

test('openPageFooter: no total, and a next offset only when there is more', () => {
  assert.equal(
    openPageFooter(0, 20, true),
    'Showing 1–20. Next page: `offset: 20`.',
  );
  assert.equal(openPageFooter(20, 5, false), 'Showing 21–25.');
  assert.equal(openPageFooter(0, 0, true), '');
});

test('offsetParam: defaults to 0 and accepts only non-negative integers', () => {
  const schema = offsetParam();
  assert.equal(schema.parse(undefined), 0);
  assert.equal(schema.parse(7), 7);
  assert.equal(schema.safeParse(-1).success, false);
  assert.equal(schema.safeParse(1.5).success, false);
});
