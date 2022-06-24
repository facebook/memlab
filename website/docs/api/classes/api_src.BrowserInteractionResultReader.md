---
id: "api_src.BrowserInteractionResultReader"
title: "Class: BrowserInteractionResultReader"
sidebar_label: "BrowserInteractionResultReader"
custom_edit_url: null
---

[api/src](../modules/api_src.md).BrowserInteractionResultReader

A utility entity to read all generated files from
the directory holding the data and results from the
last browser interaction run

## Hierarchy

- `default`

  ↳ **`BrowserInteractionResultReader`**

## Methods

### cleanup

▸ **cleanup**(): `void`

clean up data/files generated from the memlab run

#### Returns

`void`

#### Inherited from

BaseResultReader.cleanup

#### Defined in

api/src/result-reader/BaseResultReader.ts:72

___

### getInteractionSteps

▸ **getInteractionSteps**(): `E2EStepInfo`[]

browser interaction step sequence

#### Returns

`E2EStepInfo`[]

an array of browser interaction step info

#### Defined in

api/src/result-reader/BrowserInteractionResultReader.ts:60

___

### getRootDirectory

▸ **getRootDirectory**(): `string`

get the directory where the data and generated files of
the memlab run were stored

#### Returns

`string`

absolute path of the directory

#### Inherited from

BaseResultReader.getRootDirectory

#### Defined in

api/src/result-reader/BaseResultReader.ts:64

___

### getRunMetaInfo

▸ **getRunMetaInfo**(): `RunMetaInfo`

general meta data of the browser interaction run

#### Returns

`RunMetaInfo`

meta data about the entire browser interaction

#### Defined in

api/src/result-reader/BrowserInteractionResultReader.ts:72

___

### getSnapshotFileDir

▸ **getSnapshotFileDir**(): `string`

get the directory holding all snapshot files

#### Returns

`string`

the absolute path of the directory

#### Defined in

api/src/result-reader/BrowserInteractionResultReader.ts:51

___

### getSnapshotFiles

▸ **getSnapshotFiles**(): `string`[]

get all snapshot files

#### Returns

`string`[]

an array of snapshot file's absolute path

#### Defined in

api/src/result-reader/BrowserInteractionResultReader.ts:38

___

### from

▸ `Static` **from**(`workDir?`): [`BrowserInteractionResultReader`](api_src.BrowserInteractionResultReader.md)

build a result reader

#### Parameters

| Name | Type | Default value | Description |
| :------ | :------ | :------ | :------ |
| `workDir` | `string` | `''` | absolute path of the directory where the data and generated files of the browser interaction run were stored |

#### Returns

[`BrowserInteractionResultReader`](api_src.BrowserInteractionResultReader.md)

the ResultReader instance

#### Overrides

BaseResultReader.from

#### Defined in

api/src/result-reader/BrowserInteractionResultReader.ts:30
