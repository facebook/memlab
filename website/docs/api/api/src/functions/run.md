# Function: run()

> **run**(`options`): `Promise`\<[`RunResult`](../type-aliases/RunResult.md)\>

Defined in: api/src/API.ts:188

This API runs browser interaction and find memory leaks triggered in browser
This is equivalent to running `memlab run` in CLI.
This is also equivalent to warm up, and call [takeSnapshots](takeSnapshots.md)
and [findLeaks](findLeaks.md).

## Parameters

### options

[`RunOptions`](../type-aliases/RunOptions.md) = `{}`

## Returns

`Promise`\<[`RunResult`](../type-aliases/RunResult.md)\>

memory leaks detected and a utility reading browser
interaction results from disk
* **Examples**:
```javascript
const {run} = require('@memlab/api');

(async function () {
  const scenario = {
    url: () => 'https://www.facebook.com',
  };
  const {leaks} = await run({scenario});
})();
```
