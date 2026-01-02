# Function: takeSnapshots()

> **takeSnapshots**(`options`): `Promise`\<[`BrowserInteractionResultReader`](../classes/BrowserInteractionResultReader.md)\>

Defined in: api/src/API.ts:221

This API runs E2E interaction and takes heap snapshots.
This is equivalent to running `memlab snapshot` in CLI.

## Parameters

### options

[`RunOptions`](../type-aliases/RunOptions.md) = `{}`

configure browser interaction run

## Returns

`Promise`\<[`BrowserInteractionResultReader`](../classes/BrowserInteractionResultReader.md)\>

a utility reading browser interaction results from disk
* **Examples**:
```javascript
const {takeSnapshots} = require('@memlab/api');

(async function () {
  const scenario = {
    url: () => 'https://www.facebook.com',
  };
  const result = await takeSnapshots({scenario});
})();
```
