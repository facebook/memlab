import {test, expect} from '@memlab/playwright';
import type {LeakFilterFn} from '@memlab/playwright';
import type {ISerializedInfo} from '@memlab/core';

const BASE = 'http://127.0.0.1:5174';

// Each leak fixture retains makePayload() ≈ 50k × ~50B ≈ 2.5MB. A 100KB
// floor sits comfortably above Playwright's inspector retention and well
// below the real leak; 1MB is the conservative lower bound we assert on.
const RETAINED_SIZE_THRESHOLD = 100_000;
const PAYLOAD_MIN_BYTES = 1_000_000;
const retainedSizeFilter: LeakFilterFn = node =>
  node.retainedSize > RETAINED_SIZE_THRESHOLD;

const PATTERNS = [
  'interval',
  'window-listener',
  'promise',
  'store',
  'global-ref',
  'observer',
  'raf',
] as const;

// memlab encodes retained size into ISerializedInfo keys as
// `$retained-size:N` (packages/core/src/lib/Serializer.ts:40-43). Walk
// the recursive dict and return the max N seen anywhere in the trace.
const RETAIN_SIZE_RX = /\$retained-size:(\d+)/;
function maxRetainedSize(info: ISerializedInfo): number {
  let max = 0;
  const walk = (value: unknown): void => {
    if (value == null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const m = RETAIN_SIZE_RX.exec(key);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
      walk(child);
    }
  };
  walk(info);
  return max;
}

async function runPattern(
  page: import('@playwright/test').Page,
  memlab: import('@memlab/playwright').MemlabFixture,
  mode: string,
): Promise<ISerializedInfo[]> {
  await page.goto(`${BASE}/?mode=${mode}`);
  await page.waitForSelector('#open');
  await memlab.baseline();
  await page.click('#open');
  await page.waitForSelector('#slot');
  await page.click('#close');
  await page.waitForSelector('#slot', {state: 'detached'});
  const leaks = await memlab.findLeaks();
  return leaks ?? [];
}

for (const pattern of PATTERNS) {
  test(`[${pattern}] leaky with retainedSize filter`, async ({
    page,
    memlab,
  }) => {
    memlab.configure({leakFilter: retainedSizeFilter});
    const leaks = await runPattern(page, memlab, `${pattern}-leaky`);
    console.log(`[${pattern}-leaky] leaks=${leaks.length}`);
    expect(
      leaks.length,
      `expected ${pattern}-leaky to produce ≥1 leak, got ${leaks.length}`,
    ).toBeGreaterThan(0);
    // Size sanity: retainer trace should include a node of ~payload size.
    const maxSizes = leaks.map(maxRetainedSize);
    expect(
      maxSizes.some(s => s >= PAYLOAD_MIN_BYTES),
      `expected ≥1 leak with a retainer ≥${PAYLOAD_MIN_BYTES}B. maxSizes: [${maxSizes.join(
        ',',
      )}]`,
    ).toBe(true);
  });

  test(`[${pattern}] clean with retainedSize filter`, async ({
    page,
    memlab,
  }) => {
    memlab.configure({leakFilter: retainedSizeFilter});
    const leaks = await runPattern(page, memlab, `${pattern}-clean`);
    console.log(`[${pattern}-clean] leaks=${leaks.length}`);
    expect(
      leaks.length,
      `expected ${pattern}-clean to produce 0 leaks, got ${leaks.length}`,
    ).toBe(0);
  });
}

// Detached DOM: exercises FilterDetachedDOMElement (rule #7) specifically
// without a leakFilter. The fixture has no large payload, so a size-based
// filter would actively harm the signal here.
test('[detached-dom] leaky without filter → rule 7 catches it', async ({
  page,
  memlab,
}) => {
  const leaks = await runPattern(page, memlab, 'detached-dom-leaky');
  console.log(`[detached-dom-leaky] leaks=${leaks.length}`);
  expect(
    leaks.length,
    `expected detached-dom-leaky to produce ≥1 leak via rule 7, got ${leaks.length}`,
  ).toBeGreaterThan(0);
});

test('[detached-dom] clean without filter', async ({page, memlab}) => {
  const leaks = await runPattern(page, memlab, 'detached-dom-clean');
  console.log(`[detached-dom-clean] leaks=${leaks.length}`);
  expect(
    leaks.length,
    `expected detached-dom-clean to produce 0 leaks, got ${leaks.length}`,
  ).toBe(0);
});

// Negative control: without a user leakFilter, memlab's built-in rules
// should miss closure-retained JS state. These tests assert 0 leaks so a
// non-zero result surfaces as a test failure that's worth investigating.
for (const pattern of PATTERNS) {
  test(`[${pattern}] leaky WITHOUT filter (built-in rules only)`, async ({
    page,
    memlab,
  }) => {
    const leaks = await runPattern(page, memlab, `${pattern}-leaky`);
    console.log(`[${pattern}-leaky NO-FILTER] leaks=${leaks.length}`);
    expect(
      leaks.length,
      `built-in rules should miss ${pattern}-leaky without a leakFilter, got ${leaks.length}`,
    ).toBe(0);
  });
}
