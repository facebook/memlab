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
  return 'https://databricks.com/';
}

// action where we want to detect memory leaks
async function action(page) {
  await page.hover('a[href="/product/data-lakehouse"]');
}

// action where we want to go back to the step before
async function back(page) {
  await page.hover('a[href="/solutions"]');
}

// specify the number of repeat for the action
function repeat() {
  return 1;
}

module.exports = {action, back, repeat, url};
