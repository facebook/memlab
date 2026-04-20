import path from 'path';
import {pathToFileURL} from 'url';
import {test, expect} from '@memlab/playwright/test';
import {PlaywrightHeapCapturer} from '@memlab/playwright';

const leakyUrl = pathToFileURL(
  path.join(__dirname, 'fixtures', 'react-leak.html'),
).href;
const cleanUrl = pathToFileURL(
  path.join(__dirname, 'fixtures', 'clean.html'),
).href;

async function openThenClose(page: import('@playwright/test').Page, detachSel: string) {
  await page.click('#open');
  await page.waitForSelector(detachSel);
  await page.click('#close');
  await page.waitForSelector(detachSel, {state: 'detached'});
}

// Uses the low-level capturer so we can assert on the leak count directly
// without the fixture's auto soft-fail behavior.
test('leaky React component is detected', async ({page}) => {
  await page.goto(leakyUrl);
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

// Uses the high-level fixture. Relies on the fixture's auto soft-fail being
// silent when no leak is found.
test('clean React component passes the fixture', async ({page, memlab}) => {
  await page.goto(cleanUrl);
  await page.waitForSelector('#open');

  await memlab.baseline();
  await openThenClose(page, '#clean');
  // target + final captured automatically at fixture teardown.
});

test('no-op when memlab is not destructured', async ({page}) => {
  await page.goto(cleanUrl);
  await page.waitForSelector('#open');
  await page.click('#open');
  expect(await page.textContent('#clean')).toContain('50000');
});
