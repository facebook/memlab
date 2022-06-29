/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 * @oncall ws_labs
 */

// initial page load's url
function url() {
  return 'https://www.youtube.com';
}

// action where we want to detect memory leaks
async function action(page) {
  await page.click('[id="video-title-link"]');
}

// action where we want to go back to the step before
async function back(page) {
  await page.click('[id="logo-icon"]');
}

// specify the number of repeat for the action
function repeat() {
  return 5;
}

module.exports = {action, back, repeat, url};
