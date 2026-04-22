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

Chromium only — heap snapshots go over CDP, which Playwright exposes
only for Chromium. Firefox / WebKit projects get a `memlab-skip`
annotation and a no-op fixture.

## Online Resources
* [Official Website and Demo](https://facebook.github.io/memlab)
* [Documentation](https://facebook.github.io/memlab/docs/intro)
