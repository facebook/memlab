/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * @nolint
 * @oncall web_perf_infra
 */

function url() {
  return 'http://localhost:3000/';
}

// action where you suspect the memory leak might be happening
async function action(page) {
  await page.click('a[href="/examples/oversized-object"]');
}

// how to go back to the state before actionw
async function back(page) {
  await page.click('a[href="/"]');
}

// leakFilter is called with each object (node) in browser
// allocated by `action` but not released after the `back` call
function leakFilter(node, _snapshot, _leakedNodeIds) {
  return node.retainedSize > 1000 * 1000;
}

module.exports = {action, back, leakFilter, url};
