// @nolint
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

// function leakFilter(node, heap, snapshot) {
//   return node.references?.some(
//     (reference) => reference.name_or_index === 'bigArray'
//   );
// }

module.exports = { action, back, url };
