# Type Alias: InteractionsCallback()

> **InteractionsCallback** = (`page`, `args?`) => `Promise`\<`void`\>

Defined in: core/src/lib/Types.ts:640

The callback defines browser interactions which are
used by memlab to interact with the web app under test.
For concrete examples, check out action or back.

## Parameters

### page

[`Page`](Page.md)

the puppeteer [`Page`](https://pptr.dev/api/puppeteer.page)
object, which provides APIs to interact with the web browser.
To import this type, check out [Page](Page.md).

### args?

`OperationArgs`

## Returns

`Promise`\<`void`\>

no return value
