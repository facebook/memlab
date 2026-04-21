import {test, expect} from '@memlab/playwright/test';
import {PlaywrightHeapCapturer} from '@memlab/playwright';

const BASE = 'http://127.0.0.1:5174';

async function openThenClose(page: import('@playwright/test').Page) {
  await page.click('#open');
  await page.waitForSelector('#slot');
  await page.click('#close');
  await page.waitForSelector('#slot', {state: 'detached'});
}

test('[react] leaky component is detected', async ({page}) => {
  await page.goto(`${BASE}/?mode=interval-leaky`);
  await page.waitForSelector('#open');

  const capturer = await PlaywrightHeapCapturer.attach(page);
  try {
    await capturer.snapshot('baseline');
    await openThenClose(page);
    await capturer.snapshot('target');
    await capturer.snapshot('final');

    const leaks = await capturer.findLeaks();
    expect(
      leaks.length,
      `expected leaky react component to produce at least one leak, got ${leaks.length}`,
    ).toBeGreaterThan(0);
  } finally {
    await capturer.dispose();
  }
});

test('[react] clean component passes the fixture', async ({page, memlab}) => {
  await page.goto(`${BASE}/?mode=interval-clean`);
  await page.waitForSelector('#open');
  await memlab.baseline();
  await openThenClose(page);
});

test('[react] no-op when memlab is not destructured', async ({page}) => {
  await page.goto(`${BASE}/?mode=interval-clean`);
  await page.waitForSelector('#open');
  await page.click('#open');
  expect(await page.textContent('#slot')).toContain('interval-clean');
});
