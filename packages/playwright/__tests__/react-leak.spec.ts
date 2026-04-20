import {test, expect} from '@memlab/playwright/test';
import {PlaywrightHeapCapturer} from '@memlab/playwright';

async function openThenClose(
  page: import('@playwright/test').Page,
  detachSel: string,
) {
  await page.click('#open');
  await page.waitForSelector(detachSel);
  await page.click('#close');
  await page.waitForSelector(detachSel, {state: 'detached'});
}

// Low-level capturer path: directly assert on the number of leak traces
// without going through the fixture's soft-fail behavior. This verifies
// memlab actually detects the intentional leak in a production-shaped
// React app served over HTTP by Vite.
test('leaky React component is detected', async ({page}) => {
  await page.goto('/?mode=leaky');
  await page.waitForSelector('#open');

  const capturer = await PlaywrightHeapCapturer.attach(page);
  try {
    await capturer.snapshot('baseline');
    await openThenClose(page, '#leaky');
    await capturer.snapshot('target');
    await capturer.snapshot('final');

    const leaks = await capturer.findLeaks();
    expect(
      leaks.length,
      `expected the leaky component to produce at least one leak trace, got ${leaks.length}`,
    ).toBeGreaterThan(0);
  } finally {
    await capturer.dispose();
  }
});

// High-level fixture path: relies on the fixture's auto soft-fail being
// silent when no leak is found.
test('clean React component passes the fixture', async ({page, memlab}) => {
  await page.goto('/?mode=clean');
  await page.waitForSelector('#open');

  await memlab.baseline();
  await openThenClose(page, '#clean');
  // target + final captured automatically at fixture teardown.
});

test('no-op when memlab is not destructured', async ({page}) => {
  await page.goto('/?mode=clean');
  await page.waitForSelector('#open');
  await page.click('#open');
  expect(await page.textContent('#clean')).toContain('50000');
});
