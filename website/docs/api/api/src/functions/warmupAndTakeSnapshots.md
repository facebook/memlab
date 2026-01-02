# Function: warmupAndTakeSnapshots()

> **warmupAndTakeSnapshots**(`options`): `Promise`\<[`BrowserInteractionResultReader`](../classes/BrowserInteractionResultReader.md)\>

Defined in: api/src/API.ts:151

This API warms up web server, runs E2E interaction, and takes heap snapshots.
This is equivalent to running `memlab warmup-and-snapshot` in CLI.
This is also equivalent to warm up and call [takeSnapshots](takeSnapshots.md).

## Parameters

### options

[`RunOptions`](../type-aliases/RunOptions.md) = `{}`

configure browser interaction run

## Returns

`Promise`\<[`BrowserInteractionResultReader`](../classes/BrowserInteractionResultReader.md)\>

browser interaction results
* **Examples**:
```javascript
const {warmupAndTakeSnapshots} = require('@memlab/api');

(async function () {
  const scenario = {
    url: () => 'https://www.facebook.com',
  };
  const result = await warmupAndTakeSnapshots({scenario});
})();
```
