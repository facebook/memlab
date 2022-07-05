// @nolint

// memlab/packages/e2e/static/example/scenario/event-listener.js
function url() {
  return "http://localhost:3000/";
}

// action where you suspect the memory leak might be happening
async function action(page) {
  await page.click('a[href="/examples/event-listener"]');
}

// how to go back to the state before actionw
async function back(page) {
  await page.click('a[href="/"]');
}

// function leakFilter(node, _snapshot, _leakedNodeIds) {
//   return node.retainedSize > 1000 * 1000;
// };

module.exports = { action, back, url, leakFilter };
