/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

// initial page load's url
function url() {
  return 'https://www.ebay.com/';
}

// action where we want to detect memory leaks
async function action(page) {
  const arr = await page.$x("//button[contains(., 'Shop by category')]");
  if (arr[0]) {
    await arr[0].click();
  }
  arr.forEach(elem => elem.dispose());
}

// action where we want to go back to the step before
async function back(page) {
  const arr = await page.$x("//button[contains(., 'Shop by category')]");
  if (arr[0]) {
    await arr[0].click();
  }
  arr.forEach(elem => elem.dispose());
}

// specify the number of repeat for the action
function repeat() {
  return 3;
}

module.exports = {action, back, repeat, url};
