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
import utils from '../../lib/Utils';

const simplifyTagAttributes = utils.simplifyTagAttributes;

beforeEach(() => {
  config.isTest = true;
});

test('basic tag with no attributes', () => {
  expect(simplifyTagAttributes('Hello <div>')).toBe('Hello <div>');
});

test('opening tag with multiple attributes', () => {
  expect(simplifyTagAttributes('Text <div class="a" id="b">')).toBe(
    'Text <div id="b" class="a">',
  );
});

test('tag with boolean attributes', () => {
  expect(simplifyTagAttributes('<input disabled required>')).toBe(
    '<input disabled required>',
  );
});

test('tag with self-closing syntax', () => {
  expect(simplifyTagAttributes('<img src="x.jpg" alt="y" />')).toBe(
    '<img src="x.jpg" alt="y" />',
  );
});

test('tag with mixed boolean and key-value attributes', () => {
  expect(simplifyTagAttributes('<input disabled type="text">')).toBe(
    '<input disabled type="text">',
  );
});

test('tag with reordered prioritized attributes', () => {
  expect(
    simplifyTagAttributes('<div class="a" data-id="123" title="test">'),
  ).toBe('<div class="a" data-id="123" title="test">');
});

test('tag with long attribute value gets pushed back', () => {
  const longVal = 'x'.repeat(100);
  expect(simplifyTagAttributes(`<div class="a" data-id="${longVal}">`)).toBe(
    `<div class="a" data-id="${longVal}">`,
  );
});

test('closing tags are preserved', () => {
  expect(simplifyTagAttributes('Something </div>')).toBe('Something </div>');
});

test('malformed tag returns fixed tag', () => {
  const input = 'Hello <div class="test"';
  expect(simplifyTagAttributes(input)).toBe('Hello <div class="test">');
});

test('prefix before tag is preserved', () => {
  expect(simplifyTagAttributes('Detached <div class="x">')).toBe(
    'Detached <div class="x">',
  );
});

test('only parses and simplifies the first tag', () => {
  expect(simplifyTagAttributes('Wrap <div id="x">text<span id="y">')).toBe(
    'Wrap <div id="x">',
  );
});

test('tag longer than 150 chars is trimmed', () => {
  const longAttr = 'data-desc="' + 'x'.repeat(200) + '"';
  const input = `Intro <div id="x" ${longAttr}>`;
  const expectedStart = 'Intro <div id="x"';
  const output = simplifyTagAttributes(input);
  expect(output.startsWith(expectedStart)).toBe(true);
  expect(output.length).toBeLessThanOrEqual(153);
  expect(output.endsWith('...')).toBe(true);
});

test('complex tag example', () => {
  expect(
    simplifyTagAttributes(
      'Detached <div class="CometPressableOverlay__styles.overlay x1ey2m1c ' +
        'xds687c x17qophe x47corl x10l6tqk x13vifvy x19991ni x1dhq9h ' +
        'CometPressableOverlay__styles.overlayWeb x1o1ewxj x3x9cwd x1e5q0jg ' +
        'x13rtm0m CometPressableOverlay__styles.overlayVisible x1hc1fzr ' +
        'x1mq3mr6 CometPressableOverlay__styles.defaultHoveredStyle ' +
        'x1wpzbip" role="none" data-visualcompletion="ignore" ' +
        'style="border-radius: 9px; inset: 0px;">',
    ),
  ).toBe(
    'Detached <div role="none" class="CometPressableOverlay__styles.overlay ' +
      'x1ey2m1c xds687c x17qophe x47...',
  );
});

test('prioritized order are respected', () => {
  expect(
    simplifyTagAttributes(
      'Detached <div a b c="c" d="d" e f g>',
      new Set(['g', 'c', 'e']),
    ),
  ).toBe('Detached <div g c="c" e a b d="d" f>');
  expect(
    simplifyTagAttributes(
      'Detached <div class="x78zum5" data-testids=" | GeoBaseText | GeoBaseText">',
    ),
  ).toBe(
    'Detached <div data-testids=" | GeoBaseText | GeoBaseText" class="x78zum5">',
  );
});
