/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

// initial page load's url
function url() {
  return 'https://www.shopify.com/';
}

// action where we want to detect memory leaks
async function action(page) {
  await page.click('input[data-trekkie-id="Main Nav Get Started"]');
}

// action where we want to go back to the step before
async function back(page) {
  await page.click('button[id="CloseModal"]');
}

// specify the number of repeat for the action
function repeat() {
  return 3;
}

module.exports = {action, back, repeat, url};
