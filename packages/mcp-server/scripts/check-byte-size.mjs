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
 * Unit tests for the byte-size parsing every size filter goes through.
 *
 *   npm run build-pkg && npm run test-units
 *
 * Runs against the BUILT dist/, so it needs the package's dependencies (zod)
 * installed, the same as check-fixtures.mjs.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, '..', 'dist', 'byte-size.js');
if (!fs.existsSync(built)) {
  console.error('check-byte-size: dist/byte-size.js is missing; build first.');
  process.exit(1);
}
const {parseByteSize, parseByteRange, inByteRange, sizeInput} = await import(
  pathToFileURL(built).href
);
const {z} = await import('zod');

test('parseByteSize: a bare number is bytes', () => {
  assert.equal(parseByteSize('0'), 0);
  assert.equal(parseByteSize('1500'), 1500);
  assert.equal(parseByteSize(' 1500 '), 1500);
});

test('parseByteSize: decimal units are powers of 1000', () => {
  assert.equal(parseByteSize('1B'), 1);
  assert.equal(parseByteSize('1k'), 1e3);
  assert.equal(parseByteSize('1KB'), 1e3);
  assert.equal(parseByteSize('1.5MB'), 1.5e6);
  assert.equal(parseByteSize('2GB'), 2e9);
});

test('parseByteSize: binary units are powers of 1024', () => {
  assert.equal(parseByteSize('1KiB'), 1024);
  assert.equal(parseByteSize('2MiB'), 2 * 1024 ** 2);
  assert.equal(parseByteSize('1GiB'), 1024 ** 3);
});

test('parseByteSize: units are case-insensitive and may follow a space', () => {
  assert.equal(parseByteSize('500kb'), 500e3);
  assert.equal(parseByteSize('500 KB'), 500e3);
  assert.equal(parseByteSize('1 mib'), 1024 ** 2);
});

test('parseByteSize: a leading-dot fraction parses and rounds to whole bytes', () => {
  assert.equal(parseByteSize('.5KB'), 500);
  assert.equal(parseByteSize('1.0005KB'), 1001);
});

test('parseByteSize: rejects anything that is not a size, naming the input', () => {
  for (const bad of ['', 'abc', '1XB', '-1', '1e3', '1 MB extra', '1..5MB']) {
    assert.throws(
      () => parseByteSize(bad),
      err => err.message.includes(`"${bad}" is not a size`),
      bad,
    );
  }
});

test('parseByteRange: a number or a single size is a minimum', () => {
  assert.deepEqual(parseByteRange(2048), {min: 2048, max: Infinity});
  assert.deepEqual(parseByteRange('1MB'), {min: 1e6, max: Infinity});
});

test('parseByteRange: "a-b", "-b" and "a-" bound one or both ends', () => {
  assert.deepEqual(parseByteRange('1MB-10MB'), {min: 1e6, max: 1e7});
  assert.deepEqual(parseByteRange(' 1MB - 10MB '), {min: 1e6, max: 1e7});
  assert.deepEqual(parseByteRange('-1MB'), {min: 0, max: 1e6});
  assert.deepEqual(parseByteRange('500KB-'), {min: 500e3, max: Infinity});
});

test('parseByteRange: rejects negative, non-finite and malformed ranges', () => {
  assert.throws(() => parseByteRange(-1), /is not a size/);
  assert.throws(() => parseByteRange(NaN), /is not a size/);
  assert.throws(() => parseByteRange(Infinity), /is not a size/);
  assert.throws(() => parseByteRange('-'), /is not a size range/);
  assert.throws(() => parseByteRange('1MB-2MB-3MB'), /is not a size range/);
  assert.throws(() => parseByteRange('10MB-1MB'), /lower bound is above/);
  assert.throws(() => parseByteRange('1XB-2MB'), /is not a size/);
});

test('inByteRange: null matches everything, and both bounds are inclusive', () => {
  assert.equal(inByteRange(123, null), true);
  const range = {min: 100, max: 200};
  assert.equal(inByteRange(99, range), false);
  assert.equal(inByteRange(100, range), true);
  assert.equal(inByteRange(200, range), true);
  assert.equal(inByteRange(201, range), false);
});

test('sizeInput: numbers pass through and size strings become bytes', () => {
  const schema = sizeInput();
  assert.equal(schema.parse(4096), 4096);
  assert.equal(schema.parse('4KiB'), 4096);
  assert.equal(schema.parse('1.5MB'), 1.5e6);
});

test("sizeInput: the base schema's constraints apply to a parsed string too", () => {
  const schema = sizeInput(z.number().min(1000));
  assert.equal(schema.parse('1KB'), 1000);
  assert.equal(schema.safeParse('500B').success, false);
  assert.equal(schema.safeParse(500).success, false);
});

test('sizeInput: an unparseable string is a validation issue, not a throw', () => {
  const result = sizeInput().safeParse('lots');
  assert.equal(result.success, false);
  assert.match(result.error.issues[0].message, /"lots" is not a size/);
});
