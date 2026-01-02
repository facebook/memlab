# Type Alias: CheckPageLoadCallback()

> **CheckPageLoadCallback** = (`page`) => `Promise`\<`boolean`\>

Defined in: core/src/lib/Types.ts:1168

Callback function to provide if the page is loaded.
For concrete example, check out isPageLoaded.

## Parameters

### page

[`Page`](Page.md)

puppeteer's [Page](https://pptr.dev/api/puppeteer.page/) object.
To import this type, check out [Page](Page.md).

## Returns

`Promise`\<`boolean`\>

a boolean value, if it returns `true`, memlab will consider
the navigation completes, if it returns `false`, memlab will keep calling
this callback until it returns `true`. This is an async callback, you can
also `await` and returns `true` until some async logic is resolved.
