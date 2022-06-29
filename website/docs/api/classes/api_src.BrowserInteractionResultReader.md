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

### <a id="cleanup"></a>**cleanup**()

clean up data/files generated from the memlab run

 * **Returns**: `void`
 * **Source**:
    * api/src/result-reader/BaseResultReader.ts:72

___

### <a id="getinteractionsteps"></a>**getInteractionSteps**()

browser interaction step sequence

 * **Returns**: `E2EStepInfo`[] | an array of browser interaction step info

 * **Source**:
    * api/src/result-reader/BrowserInteractionResultReader.ts:60

___

### <a id="getrootdirectory"></a>**getRootDirectory**()

get the directory where the data and generated files of
the memlab run were stored

 * **Returns**: `string` | absolute path of the directory

 * **Source**:
    * api/src/result-reader/BaseResultReader.ts:64

___

### <a id="getrunmetainfo"></a>**getRunMetaInfo**()

general meta data of the browser interaction run

 * **Returns**: `RunMetaInfo` | meta data about the entire browser interaction

 * **Source**:
    * api/src/result-reader/BrowserInteractionResultReader.ts:72

___

### <a id="getsnapshotfiledir"></a>**getSnapshotFileDir**()

get the directory holding all snapshot files

 * **Returns**: `string` | the absolute path of the directory

 * **Source**:
    * api/src/result-reader/BrowserInteractionResultReader.ts:51

___

### <a id="getsnapshotfiles"></a>**getSnapshotFiles**()

get all snapshot files

 * **Returns**: `string`[] | an array of snapshot file's absolute path

 * **Source**:
    * api/src/result-reader/BrowserInteractionResultReader.ts:38

___

### <a id="from"></a>`Static` **from**(`workDir?`)

build a result reader

 * **Parameters**:
    * `workDir`: `string` | `''` | absolute path of the directory where the data and generated files of the browser interaction run were stored
 * **Returns**: [`BrowserInteractionResultReader`](api_src.BrowserInteractionResultReader.md) | the ResultReader instance

 * **Source**:
    * api/src/result-reader/BrowserInteractionResultReader.ts:30
