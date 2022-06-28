---
id: "heap_analysis_src.ObjectSizeAnalysis"
title: "Class: ObjectSizeAnalysis"
sidebar_label: "ObjectSizeAnalysis"
custom_edit_url: null
---

[heap-analysis/src](../modules/heap_analysis_src.md).ObjectSizeAnalysis

## Hierarchy

- [`BaseAnalysis`](heap_analysis_src.BaseAnalysis.md)

  ↳ **`ObjectSizeAnalysis`**

## Constructors

### <a id="new objectsizeanalysis"></a>**new ObjectSizeAnalysis**()

## Methods

### <a id="analyzesnapshotfromfile"></a>**analyzeSnapshotFromFile**(`file`)

 * **Parameters**:
    * `file`: `string`
 * **Returns**: `Promise`<`any`\>
 * **Source**:
    * `heap-analysis/src/BaseAnalysis.ts:52`

___

### <a id="analyzesnapshotsindirectory"></a>**analyzeSnapshotsInDirectory**(`directory`)

 * **Parameters**:
    * `directory`: `string`
 * **Returns**: `Promise`<`any`\>
 * **Source**:
    * `heap-analysis/src/BaseAnalysis.ts:62`

___

### <a id="getcommandname"></a>**getCommandName**()

 * **Returns**: `string`
 * **Source**:
    * `heap-analysis/src/plugins/ObjectSizeAnalysis.ts:19`

___

### <a id="getdescription"></a>**getDescription**()

 * **Returns**: `string`
 * **Source**:
    * `heap-analysis/src/plugins/ObjectSizeAnalysis.ts:23`

___

### <a id="getoptions"></a>**getOptions**()

 * **Returns**: `default`[]
 * **Source**:
    * `heap-analysis/src/plugins/ObjectSizeAnalysis.ts:27`

___

### <a id="process"></a>**process**(`options`)

 * **Parameters**:
    * `options`: `HeapAnalysisOptions`
 * **Returns**: `Promise`<`void`\>
 * **Source**:
    * `heap-analysis/src/plugins/ObjectSizeAnalysis.ts:31`

___

### <a id="run"></a>**run**(`options?`)

 * **Parameters**:
    * `options`: `HeapAnalysisOptions` | `pluginUtils.defaultAnalysisArgs`
 * **Returns**: `Promise`<`any`\>
 * **Source**:
    * `heap-analysis/src/BaseAnalysis.ts:45`
