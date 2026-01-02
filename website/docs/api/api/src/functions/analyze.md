# Function: analyze()

> **analyze**(`runResult`, `heapAnalyzer`, `args`): `Promise`\<`void`\>

Defined in: api/src/API.ts:328

This API analyzes heap snapshot(s) with a specified heap analysis.
This is equivalent to `memlab analyze` in CLI.

## Parameters

### runResult

`BaseResultReader`

return value of a browser interaction run

### heapAnalyzer

`BaseAnalysis`

instance of a heap analysis

### args

`ParsedArgs` = `...`

other CLI arguments that needs to be passed to the heap analysis

## Returns

`Promise`\<`void`\>

each analysis may have a different return type, please check out
the type definition or the documentation for the `process` method of the
analysis class you are using for `heapAnalyzer`.
* **Examples**:
```javascript
const {analyze, takeSnapshots, StringAnalysis} = require('@memlab/api');

(async function () {
  const scenario = {
    url: () => 'https://www.facebook.com',
  };
  const result = await takeSnapshots({scenario});
  const analysis = new StringAnalysis();
  await analyze(result, analysis);
})();
```
