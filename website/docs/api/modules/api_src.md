---
id: "api_src"
title: "Module: api/src"
sidebar_label: "api/src"
sidebar_position: 0
custom_edit_url: null
---

## Classes

- [BrowserInteractionResultReader](../classes/api_src.BrowserInteractionResultReader.md)

## Type Aliases

### RunOptions

Ƭ **RunOptions**: `Object`

Options for configuring browser interaction run

#### Type declaration

| Name | Type | Description |
| :------ | :------ | :------ |
| `cookiesFile?` | `string` | cookies file |
| `evalInBrowserAfterInitLoad?` | `AnyFunction` | function to be evaluated in browser context after the web page initial load |
| `scenario?` | `IScenario` | test scenario definition |
| `snapshotForEachStep?` | `boolean` | if true, take heap snapshot for each interaction step, by default this is false, which means memlab will decide which steps it will take heap snapshots |

#### Defined in

api/src/API.ts:44

## Functions

### analyze

▸ **analyze**(`runResult`, `heapAnalyzer`, `args?`): `Promise`<`AnyValue`\>

This API analyzes heap snapshot(s) with a specified heap analysis.
This is equivalent to `memlab analyze` in CLI.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `runResult` | [`BrowserInteractionResultReader`](../classes/api_src.BrowserInteractionResultReader.md) | return value of a browser interaction run |
| `heapAnalyzer` | `BaseAnalysis` | instance of a heap analysis |
| `args` | `ParsedArgs` | other CLI arguments that needs to be passed to the heap analysis |

#### Returns

`Promise`<`AnyValue`\>

#### Defined in

api/src/API.ts:165

___

### findLeaks

▸ **findLeaks**(`runResult`): `Promise`<`ISerializedInfo`[]\>

This API finds memory leaks by analyzing heap snapshot(s)
This is equivalent to `memlab find-leaks` in CLI.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `runResult` | [`BrowserInteractionResultReader`](../classes/api_src.BrowserInteractionResultReader.md) | return value of a browser interaction run |

#### Returns

`Promise`<`ISerializedInfo`[]\>

an array of leak traces detected and clustered from the
browser interaction

#### Defined in

api/src/API.ts:147

___

### run

▸ **run**(`options?`): `Promise`<`ISerializedInfo`[]\>

This API runs browser interaction and find memory leaks triggered in browser
This is equivalent to run `memlab run` in CLI.
This is also equivalent to call {@link warmup}, [takeSnapshots](api_src.md#takesnapshots),
and [findLeaks](api_src.md#findleaks).

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `options` | [`RunOptions`](api_src.md#runoptions) | configure browser interaction run |

#### Returns

`Promise`<`ISerializedInfo`[]\>

an array of leak traces detected and clustered from the
browser interaction

#### Defined in

api/src/API.ts:104

___

### takeSnapshots

▸ **takeSnapshots**(`options?`): `Promise`<[`BrowserInteractionResultReader`](../classes/api_src.BrowserInteractionResultReader.md)\>

This API runs E2E interaction and takes heap snapshots.
This is equivalent to run `memlab snapshot` in CLI.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `options` | [`RunOptions`](api_src.md#runoptions) | configure browser interaction run |

#### Returns

`Promise`<[`BrowserInteractionResultReader`](../classes/api_src.BrowserInteractionResultReader.md)\>

browser interaction results

#### Defined in

api/src/API.ts:126

___

### warmupAndTakeSnapshots

▸ **warmupAndTakeSnapshots**(`options?`): `Promise`<[`BrowserInteractionResultReader`](../classes/api_src.BrowserInteractionResultReader.md)\>

This API warms up web server, runs E2E interaction, and takes heap snapshots.
This is equivalent to run `memlab warmup-and-snapshot` in CLI.
This is also equivalent to call {@link warmup} and [takeSnapshots](api_src.md#takesnapshots).

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `options` | [`RunOptions`](api_src.md#runoptions) | configure browser interaction run |

#### Returns

`Promise`<[`BrowserInteractionResultReader`](../classes/api_src.BrowserInteractionResultReader.md)\>

browser interaction results

#### Defined in

api/src/API.ts:80
