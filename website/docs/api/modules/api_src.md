---
id: "api_src"
title: "Package: @memlab/api"
sidebar_label: "api/src"
sidebar_position: 0
custom_edit_url: null
---

## Classes

- [BrowserInteractionResultReader](../classes/api_src.BrowserInteractionResultReader.md)

## Type Aliases

### <a id="runoptions" name="runoptions"></a> **RunOptions**: `Object`

Options for configuring browser interaction run, all fields are optional

| Name | Type | Description |
| :------ | :------ | :------ |
| `cookiesFile?` | `string` | the absolute path of cookies file |
| `evalInBrowserAfterInitLoad?` | `AnyFunction` | function to be evaluated in browser context after the web page initial load |
| `scenario?` | `IScenario` | test scenario specifying how to interact with browser (for more details view [IScenario](../interfaces/core_src.IScenario.md)) |
| `snapshotForEachStep?` | `boolean` | if true, take heap snapshot for each interaction step, by default this is false, which means memlab will decide which steps it will take heap snapshots |
| `workDir?` | `string` | specify the working directory where you want memlab to dump heap snapshots and other meta data of the test run. If no working directory is provided, memlab will generate a random temp directory under the operating system's default directory for temporary files. Note: It's the caller's responsibility to make sure the specified working directory exists. |

 * **Source**:
    * api/src/API.ts:43

___

### <a id="runresult" name="runresult"></a> **RunResult**: `Object`

A data structure holding the result of the [run](api_src.md#run) API call.

| Name | Type | Description |
| :------ | :------ | :------ |
| `leaks` | `ISerializedInfo`[] | leak traces detected and clustered from the browser interaction |
| `runResult` | [`BrowserInteractionResultReader`](../classes/api_src.BrowserInteractionResultReader.md) | a utility for reading browser interaction results from disk |

 * **Source**:
    * api/src/API.ts:77

## Functions

### <a id="analyze"></a>**analyze**(`runResult`, `heapAnalyzer`, `args?`)

This API analyzes heap snapshot(s) with a specified heap analysis.
This is equivalent to `memlab analyze` in CLI.

 * **Parameters**:
    * `runResult`: [`BrowserInteractionResultReader`](../classes/api_src.BrowserInteractionResultReader.md) | return value of a browser interaction run
    * `heapAnalyzer`: `BaseAnalysis` | instance of a heap analysis
    * `args`: `ParsedArgs` | other CLI arguments that needs to be passed to the heap analysis
 * **Returns**: `Promise`<`void`\> | each analysis may have a different return type, please check out
the type definition or the documentation for the `process` method of the
analysis class you are using for `heapAnalyzer`.
* **Examples**:
```javascript
const {takeSnapshots, StringAnalysis} = require('@memlab/api');

(async function () {
  const scenario = {
    url: () => 'https://www.facebook.com',
  };
  const result = await takeSnapshots({scenario});
  const analysis = new StringAnalysis();
  await analyze(result, analysis);
})();
```

 * **Source**:
    * api/src/API.ts:249

___

### <a id="findleaks"></a>**findLeaks**(`runResult`)

This API finds memory leaks by analyzing heap snapshot(s)
This is equivalent to `memlab find-leaks` in CLI.

 * **Parameters**:
    * `runResult`: [`BrowserInteractionResultReader`](../classes/api_src.BrowserInteractionResultReader.md) | return value of a browser interaction run
 * **Returns**: `Promise`<`ISerializedInfo`[]\> | leak traces detected and clustered from the browser interaction
* **Examples**:
```javascript
const {findLeaks, takeSnapshots} = require('@memlab/api');

(async function () {
  const scenario = {
    url: () => 'https://www.facebook.com',
  };
  const result = await takeSnapshots({scenario});
  const leaks = findLeaks(result);
})();
```

 * **Source**:
    * api/src/API.ts:216

___

### <a id="run"></a>**run**(`runOptions?`)

This API runs browser interaction and find memory leaks triggered in browser
This is equivalent to running `memlab run` in CLI.
This is also equivalent to warm up, and call [takeSnapshots](api_src.md#takesnapshots)
and [findLeaks](api_src.md#findleaks).

 * **Parameters**:
    * `runOptions`: [`RunOptions`](api_src.md#runoptions) | configure browser interaction run
 * **Returns**: `Promise`<[`RunResult`](api_src.md#runresult)\> | memory leaks detected and a utility reading browser
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

 * **Source**:
    * api/src/API.ts:154

___

### <a id="takesnapshots"></a>**takeSnapshots**(`options?`)

This API runs E2E interaction and takes heap snapshots.
This is equivalent to running `memlab snapshot` in CLI.

 * **Parameters**:
    * `options`: [`RunOptions`](api_src.md#runoptions) | configure browser interaction run
 * **Returns**: `Promise`<[`BrowserInteractionResultReader`](../classes/api_src.BrowserInteractionResultReader.md)\> | a utility reading browser interaction results from disk
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

 * **Source**:
    * api/src/API.ts:185

___

### <a id="warmupandtakesnapshots"></a>**warmupAndTakeSnapshots**(`options?`)

This API warms up web server, runs E2E interaction, and takes heap snapshots.
This is equivalent to running `memlab warmup-and-snapshot` in CLI.
This is also equivalent to warm up and call [takeSnapshots](api_src.md#takesnapshots).

 * **Parameters**:
    * `options`: [`RunOptions`](api_src.md#runoptions) | configure browser interaction run
 * **Returns**: `Promise`<[`BrowserInteractionResultReader`](../classes/api_src.BrowserInteractionResultReader.md)\> | browser interaction results
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

 * **Source**:
    * api/src/API.ts:120
