# Function: findLeaks()

> **findLeaks**(`runResult`, `options`): `Promise`\<`ISerializedInfo`[]\>

Defined in: api/src/API.ts:256

This API finds memory leaks by analyzing heap snapshot(s).
This is equivalent to `memlab find-leaks` in CLI.

## Parameters

### runResult

`BaseResultReader`

return value of a browser interaction run

### options

configure memory leak detection run

#### consoleMode?

[`ConsoleMode`](../enumerations/ConsoleMode.md)

specify the terminal output
mode (see [ConsoleMode](../enumerations/ConsoleMode.md))

## Returns

`Promise`\<`ISerializedInfo`[]\>

leak traces detected and clustered from the browser interaction
* **Examples**:
```javascript
const {findLeaks, takeSnapshots} = require('@memlab/api');

(async function () {
  const scenario = {
    url: () => 'https://www.facebook.com',
  };
  const result = await takeSnapshots({scenario, consoleMode: 'SILENT'});
  const leaks = findLeaks(result, {consoleMode: 'CONTINUOUS_TEST'});
})();
```
