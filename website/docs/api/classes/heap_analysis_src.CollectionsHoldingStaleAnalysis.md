---
id: "heap_analysis_src.CollectionsHoldingStaleAnalysis"
title: "Class: CollectionsHoldingStaleAnalysis"
sidebar_label: "CollectionsHoldingStaleAnalysis"
custom_edit_url: null
---

[heap-analysis/src](../modules/heap_analysis_src.md).CollectionsHoldingStaleAnalysis

## Hierarchy

- [`BaseAnalysis`](heap_analysis_src.BaseAnalysis.md)

  ↳ **`CollectionsHoldingStaleAnalysis`**

## Constructors

### <a id="new collectionsholdingstaleanalysis"></a>**new CollectionsHoldingStaleAnalysis**()

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
    * `heap-analysis/src/plugins/CollectionsHoldingStaleAnalysis.ts:64`

___

### <a id="getdescription"></a>**getDescription**()

 * **Returns**: `string`
 * **Source**:
    * `heap-analysis/src/plugins/CollectionsHoldingStaleAnalysis.ts:68`

___

### <a id="getoptions"></a>**getOptions**()

 * **Returns**: `default`[]
 * **Source**:
    * `heap-analysis/src/plugins/CollectionsHoldingStaleAnalysis.ts:72`

___

### <a id="process"></a>**process**(`options`)

 * **Parameters**:
    * `options`: `HeapAnalysisOptions`
 * **Returns**: `Promise`<`void`\>
 * **Source**:
    * `heap-analysis/src/plugins/CollectionsHoldingStaleAnalysis.ts:85`

___

### <a id="run"></a>**run**(`options?`)

 * **Parameters**:
    * `options`: `HeapAnalysisOptions` | `pluginUtils.defaultAnalysisArgs`
 * **Returns**: `Promise`<`any`\>
 * **Source**:
    * `heap-analysis/src/BaseAnalysis.ts:45`
