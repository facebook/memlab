// @nolint
function url() {
  return "http://localhost:3000/examples/detached-dom";
}

async function action(page) {
  const [button] = await page.$x(
    "//button[contains(., 'Create detached DOMs')]"
  );
  if (button) {
    await button.click();
  }
}

async function back(page) {
  const [button] = await page.$x('a[href="/"]');
  if (button) {
    await button.click();
  }
}

module.exports = { action, back, url };
