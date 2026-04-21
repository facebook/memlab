import {test, expect} from '@playwright/test';
import type {TestInfo} from '@playwright/test';
import type {ISerializedInfo} from '@memlab/core';
import {PlaywrightHeapCapturer, LeakFilterFn} from '@memlab/playwright';

const BASE = 'http://127.0.0.1:5174';

// Remove CDP-inspector retention artifacts (Playwright's selector handles,
// DevTools console $0-$4) that memlab surfaces because the automation
// harness itself retains detached DOM — not the application.
const INSPECTOR_RX = /DevTools console|\(Inspector[^)]*\)|CommandLineAPI/i;
function stripInspectorArtifacts(
  leaks: ISerializedInfo[],
): ISerializedInfo[] {
  return leaks.filter(
    l =>
      !Object.keys(l as unknown as Record<string, unknown>).some(k =>
        INSPECTOR_RX.test(k),
      ),
  );
}

// Each leak fixture retains makePayload() ≈ 50k × ~50B ≈ 2.5MB. A 100KB
// floor sits comfortably above Playwright's inspector retention (~600B/node)
// and well below the real leak. The 1MB bound below is the conservative
// size we assert on leaky detections.
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
// `$retained-size:N` (see packages/core/src/lib/Serializer.ts:40-43).
// Walk the recursive dict and return the max N seen anywhere in the trace.
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

async function runMode(
  page: import('@playwright/test').Page,
  mode: string,
  leakFilter: LeakFilterFn | undefined,
  testInfo: TestInfo,
  label: string,
): Promise<{raw: ISerializedInfo[]; filtered: ISerializedInfo[]}> {
  await page.goto(`${BASE}/?mode=${mode}`);
  await page.waitForSelector('#open');
  const capturer = await PlaywrightHeapCapturer.attach(page, {leakFilter});
  try {
    await capturer.snapshot('baseline');
    await page.click('#open');
    await page.waitForSelector('#slot');
    await page.click('#close');
    await page.waitForSelector('#slot', {state: 'detached'});
    await capturer.snapshot('target');
    await capturer.snapshot('final');
    const raw = await capturer.findLeaks();
    const filtered = stripInspectorArtifacts(raw);
    await testInfo.attach(`${label}-raw.json`, {
      body: JSON.stringify(raw, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach(`${label}-filtered.json`, {
      body: JSON.stringify(filtered, null, 2),
      contentType: 'application/json',
    });
    return {raw, filtered};
  } finally {
    await capturer.dispose();
  }
}

for (const pattern of PATTERNS) {
  test(`[${pattern}] leaky with retainedSize filter`, async (
    {page},
    testInfo,
  ) => {
    const {raw, filtered} = await runMode(
      page,
      `${pattern}-leaky`,
      retainedSizeFilter,
      testInfo,
      pattern,
    );
    console.log(
      `[${pattern}-leaky] raw=${raw.length} filtered=${filtered.length}`,
    );
    expect(
      filtered.length,
      `expected ${pattern}-leaky to produce ≥1 leak after inspector filter, got ${filtered.length}`,
    ).toBeGreaterThan(0);
    // Size sanity: the retainer trace should include a node whose retained
    // size is at least ~1MB — i.e., the payload we stashed. This guards
    // against false positives where memlab flags *something* but it isn't
    // the retained payload.
    const maxSizes = filtered.map(maxRetainedSize);
    expect(
      maxSizes.some(s => s >= PAYLOAD_MIN_BYTES),
      `expected ≥1 leak with a retainer of ≥${PAYLOAD_MIN_BYTES}B (payload size). maxSizes: [${maxSizes.join(
        ',',
      )}]`,
    ).toBe(true);
  });

  test(`[${pattern}] clean with retainedSize filter`, async (
    {page},
    testInfo,
  ) => {
    const {raw, filtered} = await runMode(
      page,
      `${pattern}-clean`,
      retainedSizeFilter,
      testInfo,
      pattern,
    );
    console.log(
      `[${pattern}-clean] raw=${raw.length} filtered=${filtered.length}`,
    );
    expect(
      filtered.length,
      `expected ${pattern}-clean to produce 0 leaks after inspector filter, got ${filtered.length}`,
    ).toBe(0);
  });
}

// Detached DOM: exercises FilterDetachedDOMElement (rule #7) specifically
// without a size filter. The fixture has no large payload, so a size-based
// filter would actively harm the signal here.
test('[detached-dom] leaky without filter → rule 7 catches it', async (
  {page},
  testInfo,
) => {
  const {raw, filtered} = await runMode(
    page,
    'detached-dom-leaky',
    undefined,
    testInfo,
    'detached-dom-leaky',
  );
  console.log(
    `[detached-dom-leaky] raw=${raw.length} filtered=${filtered.length}`,
  );
  expect(
    filtered.length,
    `expected detached-dom-leaky to produce ≥1 leak via rule 7 alone, got ${filtered.length}`,
  ).toBeGreaterThan(0);
});

test('[detached-dom] clean without filter', async ({page}, testInfo) => {
  const {raw, filtered} = await runMode(
    page,
    'detached-dom-clean',
    undefined,
    testInfo,
    'detached-dom-clean',
  );
  console.log(
    `[detached-dom-clean] raw=${raw.length} filtered=${filtered.length}`,
  );
  expect(
    filtered.length,
    `expected detached-dom-clean to produce 0 leaks, got ${filtered.length}`,
  ).toBe(0);
});

// ---- Negative control: built-in rules alone miss closure leaks -----------
// capturer.ts:63-68 claims that without a user leakFilter, memlab's built-in
// rules flag only detached DOM / React Fiber — so JS closures retaining
// payload (timers, listeners, promises, module arrays, observers, rAF) are
// "silently missed". These tests confirm or contradict that claim.
//
// Using expect.soft so a surprise non-zero result surfaces as information
// without blocking the rest of the suite — the whole point of this matrix
// is to probe exactly what the built-ins do / don't catch.
for (const pattern of PATTERNS) {
  test(`[${pattern}] leaky WITHOUT filter (built-in rules only)`, async (
    {page},
    testInfo,
  ) => {
    const {raw, filtered} = await runMode(
      page,
      `${pattern}-leaky`,
      undefined,
      testInfo,
      `nofilter-${pattern}`,
    );
    console.log(
      `[${pattern}-leaky NO-FILTER] raw=${raw.length} filtered=${filtered.length}`,
    );
    expect
      .soft(
        filtered.length,
        `capturer docs claim built-ins silently miss closure leaks; ${pattern}-leaky NO-FILTER got ${filtered.length}`,
      )
      .toBe(0);
  });
}
