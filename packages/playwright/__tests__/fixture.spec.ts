import {test, expect} from '@memlab/playwright';
import type {LeakFilterFn} from '@memlab/playwright';
import type {Page} from '@playwright/test';

const BASE = 'http://127.0.0.1:5174';
const retainedSizeFilter: LeakFilterFn = node => node.retainedSize > 100_000;

async function openFixture(page: Page, mode: string): Promise<void> {
  await page.goto(`${BASE}/?mode=${mode}`);
  await page.waitForSelector('#open');
}

async function triggerLeakCycle(page: Page): Promise<void> {
  await page.click('#open');
  await page.waitForSelector('#slot');
  await page.click('#close');
  await page.waitForSelector('#slot', {state: 'detached'});
}

test.describe('configure({leakFilter})', () => {
  test('routes user filter through to memlab detection', async ({
    page,
    memlab,
  }) => {
    memlab.configure({leakFilter: retainedSizeFilter});
    await openFixture(page, 'store-leaky');
    await memlab.baseline();
    await triggerLeakCycle(page);
    const leaks = await memlab.findLeaks();
    expect(leaks?.length ?? 0).toBeGreaterThan(0);
  });

  test('invokes the user callback during detection', async ({
    page,
    memlab,
  }) => {
    let calls = 0;
    memlab.configure({
      leakFilter: () => {
        calls += 1;
        return true;
      },
    });
    await openFixture(page, 'store-leaky');
    await memlab.baseline();
    await triggerLeakCycle(page);
    await memlab.findLeaks();
    expect(calls).toBeGreaterThan(0);
  });
});

test.describe('configure() merge semantics', () => {
  test('later configure({gc}) preserves an earlier leakFilter', async ({
    page,
    memlab,
  }) => {
    let invoked = false;
    memlab.configure({
      leakFilter: () => {
        invoked = true;
        return false;
      },
    });
    memlab.configure({gc: {repeat: 1}});
    await openFixture(page, 'store-leaky');
    await memlab.baseline();
    await triggerLeakCycle(page);
    await memlab.findLeaks();
    expect(invoked).toBe(true);
  });
});

test.describe('configure({gc})', () => {
  test('accepts a tuned cycle without breaking detection', async ({
    page,
    memlab,
  }) => {
    memlab.configure({
      leakFilter: retainedSizeFilter,
      gc: {repeat: 1, waitBetweenMs: 50, waitAfterMs: 100},
    });
    await openFixture(page, 'store-leaky');
    await memlab.baseline();
    await triggerLeakCycle(page);
    const leaks = await memlab.findLeaks();
    expect(leaks?.length ?? 0).toBeGreaterThan(0);
  });
});

test.describe('findLeaks()', () => {
  test('returns null when baseline was not captured', async ({
    page,
    memlab,
  }) => {
    await openFixture(page, 'store-leaky');
    await triggerLeakCycle(page);
    const leaks = await memlab.findLeaks();
    expect(leaks).toBeNull();
  });
});

test.describe('expectNoLeaks()', () => {
  test('passes when the flow is clean', async ({page, memlab}) => {
    await openFixture(page, 'detached-dom-clean');
    await memlab.baseline();
    await triggerLeakCycle(page);
    await memlab.expectNoLeaks();
  });

  test('throws with leak summary when leaks are detected', async ({
    page,
    memlab,
  }) => {
    await openFixture(page, 'detached-dom-leaky');
    await memlab.baseline();
    await triggerLeakCycle(page);
    const err = await memlab.expectNoLeaks().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/memlab detected \d+ leak trace/);
  });

  test('throws when baseline is missing', async ({page, memlab}) => {
    await openFixture(page, 'store-leaky');
    const err = await memlab.expectNoLeaks().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/baseline\(\)/);
  });
});
