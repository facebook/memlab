# @memlab/playwright

Attach memlab memory-leak detection to existing Playwright tests. Two entry
points, pick the one that fits your codebase.

## Install

```bash
npm install --save-dev @memlab/playwright @playwright/test
```

## 1. Drop-in `test` with the `memlab` fixture

Swap the `@playwright/test` import for `@memlab/playwright/test`. Any test
that destructures `memlab` gets heap capture + leak analysis; tests that
don't are untouched.

```ts
import { test, expect } from '@memlab/playwright/test';

test('closing a modal does not leak', async ({ page, memlab }) => {
  await page.goto('http://localhost:3000');
  await memlab.baseline();                                // before the action
  await page.getByRole('button', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  // target + final are captured automatically at teardown
});
```

The opt-in is the parameter destructure — no tags, no config. TypeScript
catches typos. Omit `memlab` from the parameter list and the fixture never
runs (no CDP session, no cost).

### Phase capture

| Phase | When captured | Override |
| --- | --- | --- |
| `baseline` | Fallback: just before `target` (degenerate — you almost always want to call `await memlab.baseline()` explicitly after navigation) | `await memlab.baseline()` |
| `target` | End of test body | `await memlab.target()` |
| `final` | After a forced GC cycle, before teardown | `await memlab.final()` |

memlab's leak algorithm compares objects present at `target` that are still
retained at `final` but were **not** at `baseline`. Good shapes:

- Open component / close component / assert
- Navigate to view / navigate away / assert
- Mount widget / unmount widget / assert

### Output

On every run with `memlab` in the params:

- `memlab-leaks.json` attached to the test — parsed leak traces
- `baseline.heapsnapshot`, `target.heapsnapshot`, `final.heapsnapshot`
  attached — open in Chrome DevTools → Memory → Load

If any leak is reported, the test is marked failed via `expect.soft` (other
assertions still run).

## 2. Low-level capturer

If you have a custom runner or want manual control without the fixture:

```ts
import { chromium } from 'playwright';
import { PlaywrightHeapCapturer } from '@memlab/playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:3000');

const capturer = await PlaywrightHeapCapturer.attach(page);
await capturer.snapshot('baseline');

await page.click('text=Open');
await capturer.snapshot('target');

await page.click('text=Close');
await capturer.snapshot('final');

const leaks = await capturer.findLeaks();
console.log(`Found ${leaks.length} leak trace(s)`);

await capturer.dispose();
await browser.close();
```

## Framework support

Verified end-to-end against React 18 on a Vite dev server. Vue 3 and
Svelte 4 were also exercised during development with the same leak pattern
and worked once their respective dev-mode devtools hooks
(`__VUE_DEVTOOLS_HOOK_REPLAY__` etc.) were filtered, but that filtering is
not shipped by default — extend `INSPECTOR_PATTERNS` in `src/test.ts` or
use the low-level capturer to apply your own.

memlab's default detection is biased toward detached DOM / Fiber patterns.
Pure-JS leaks with no DOM involvement (e.g., module-scope `Set` accumulating
values) may be missed by the default filter and need a custom leak predicate
(tracked separately).

## Caveats

- **Chromium only.** Heap snapshots go over CDP, which Playwright exposes only
  for Chromium. Firefox / WebKit projects get an annotation on the test
  (`memlab-skip`) and a no-op fixture.
- **Snapshots are large** (tens of MB each). The fixture writes them to the
  test's output directory; `PlaywrightHeapCapturer` writes to an OS temp dir
  by default and cleans up on `dispose()`.
- **GC is heuristic.** memlab asks V8 to collect garbage before `final`, but
  references kept by long-lived structures by design will still appear as
  leaks. Triage with the JSON report and the raw snapshots.
