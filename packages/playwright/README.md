## memlab Playwright

This is the memlab Playwright integration. It exposes a drop-in `test`
fixture for `@playwright/test` so existing Playwright specs can attach
memlab's memory-leak detection by destructuring a `memlab` parameter.

```ts
import {test, expect} from '@memlab/playwright';

test('closing a modal does not leak', async ({page, memlab}) => {
  await page.goto('http://localhost:3000');
  await memlab.baseline();
  await page.getByRole('button', {name: 'Open'}).click();
  await page.getByRole('button', {name: 'Close'}).click();
  // target + final snapshots, leak detection, and the soft-assert run
  // automatically at teardown. Omit `memlab` from the parameters and
  // the fixture never attaches (no CDP session, no cost).
});
```

For the common "run a flow, assert no leaks" pattern, call
`memlab.expectNoLeaks()` — it captures target/final, runs detection, and
throws a trimmed leak summary (not the full retention dict) if any leak
trace survives. Use it when you want a hard assertion mid-test rather
than the teardown soft-assert:

```ts
test('modal close leaves no retained DOM', async ({page, memlab}) => {
  await page.goto('http://localhost:3000');
  await memlab.baseline();
  await page.getByRole('button', {name: 'Open'}).click();
  await page.getByRole('button', {name: 'Close'}).click();
  await memlab.expectNoLeaks();
});
```

Use `memlab.findLeaks()` only when you need the raw trace list (e.g. to
assert a specific leak is present in a fixture test).

Chromium only — heap snapshots go over CDP, which Playwright exposes
only for Chromium. On Firefox / WebKit the fixture becomes a no-op:
the test still runs and passes, but no leak detection happens. A
`memlab-skip` annotation records the reason. Restrict leak specs to a
Chromium project if you want them to fail loudly elsewhere.

## Online Resources
* [Official Website and Demo](https://facebook.github.io/memlab)
* [Documentation](https://facebook.github.io/memlab/docs/intro)
