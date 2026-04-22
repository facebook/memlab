import {test, expect} from '@memlab/playwright';

const BASE = 'http://127.0.0.1:5174';

async function openThenClose(page: import('@playwright/test').Page) {
  await page.click('#open');
  await page.waitForSelector('#slot');
  await page.click('#close');
  await page.waitForSelector('#slot', {state: 'detached'});
}

// Uses detached-dom-{leaky,clean} so the built-in rule chain (rule 7,
// FilterDetachedDOMElement) catches the leak without a user leakFilter.
test('[react] leaky component is detected', async ({page, memlab}) => {
  await page.goto(`${BASE}/?mode=detached-dom-leaky`);
  await page.waitForSelector('#open');
  await memlab.baseline();
  await openThenClose(page);
  const leaks = await memlab.findLeaks();
  expect(
    leaks?.length ?? 0,
    `expected leaky react component to produce at least one leak, got ${
      leaks?.length ?? 0
    }`,
  ).toBeGreaterThan(0);
});

test('[react] clean component passes the fixture', async ({page, memlab}) => {
  await page.goto(`${BASE}/?mode=detached-dom-clean`);
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
