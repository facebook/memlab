# Type Alias: Page

> **Page** = `PuppeteerPage`

Defined in: core/src/lib/Types.ts:207

This is the puppeteer [`Page`](https://pptr.dev/api/puppeteer.page)
class used by MemLab. The puppeteer `Page` class instance provides
APIs to interact with the web browser.

The puppeteer `Page` type can be incompatible across different versions.
Your local npm-installed puppeteer version may be different from
the puppeteer used by MemLab. This may cause some type errors, for example:

```typescript
import type {Page} from 'puppeteer-core';
import type {RunOptions} from '@memlab/api';

const runOptions: RunOptions = {
  scenario: {
    // initial page load url: Google Maps
    url: () => {
      return "https://www.google.com/maps/@37.386427,-122.0428214,11z";
    },
    // type error here if your local puppeeter version is different
    // from the puppeteer used by MemLab
    action: async function (page: Page) {
      await page.click('text/Hotels');
    },
  },
};
```

To avoid the type error in the code example above, MemLab exports the
puppeteer `Page` type used by MemLab so that your code can import it
when necessary:

```typescript
import type {Page} from '@memlab/core' // import Page type from memlab
import type {RunOptions} from 'memlab';

const runOptions: RunOptions = {
  scenario: {
    // initial page load url: Google Maps
    url: () => {
      return "https://www.google.com/maps/@37.386427,-122.0428214,11z";
    },
    // no type error here
    action: async function (page: Page) {
      await page.click('text/Hotels');
    },
  },
};
```
