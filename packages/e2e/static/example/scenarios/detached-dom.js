/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * @nolint
 * @oncall web_perf_infra
 */

// memlab/packages/e2e/static/example/scenario/detached-dom.js
/**
 * The initial `url` of the scenario we would like to run.
 */
function url() {
  return 'http://localhost:3000/examples/detached-dom';
}

/**
 * Specify how memlab should perform action that you want
 * to test whether the action is causing memory leak.
 *
 * @param page - Puppeteer's page object:
 * https://pptr.dev/api/puppeteer.page/
 */
async function action(page) {
  const elements = await page.$x(
    "//button[contains(., 'Create detached DOMs')]",
  );
  const [button] = elements;
  if (button) {
    await button.click();
  }
  // clean up external references from memlab
  await Promise.all(elements.map(e => e.dispose()));
}

/**
 * Specify how memlab should perform action that would
 * reset the action you performed above.
 *
 * @param page - Puppeteer's page object:
 * https://pptr.dev/api/puppeteer.page/
 */
async function back(page) {
  await page.click('a[href="/"]');
}

module.exports = {action, back, url};
