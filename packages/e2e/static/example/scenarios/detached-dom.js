// @nolint
// memlab/packages/e2e/static/example/scenario/detached-dom.js
/**
 * The initial `url` of the scenario we would like to run.
 */
function url() {
  return "http://localhost:3000/examples/detached-dom";
}

/**
 * Specify how memlab should perform action that you want
 * to test whether the action is causing memory leak.
 *
 * @param page - Puppeteer's [page object](https://pptr.dev/api/puppeteer.page/).
 */
async function action(page) {
  const [button] = await page.$x(
    "//button[contains(., 'Create detached DOMs')]"
  );
  if (button) {
    await button.click();
  }
}

/**
 * Specify how memlab should perform action that would
 * reset the action you performed above.
 *
 * @param page - Puppeteer's [page object](https://pptr.dev/api/puppeteer.page/).
 */
async function back(page) {
  const [button] = await page.$x('a[href="/"]');
  if (button) {
    await button.click();
  }
}

module.exports = { action, back, url };
