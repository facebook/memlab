---
id: "heap_analysis_src.GlobalVariableAnalysis"
title: "Class: GlobalVariableAnalysis"
sidebar_label: "GlobalVariableAnalysis"
custom_edit_url: null
---

[heap-analysis/src](../modules/heap_analysis_src.md).GlobalVariableAnalysis

## Hierarchy

- [`BaseAnalysis`](heap_analysis_src.BaseAnalysis.md)

  ↳ **`GlobalVariableAnalysis`**

## Constructors

### <a id="new globalvariableanalysis"></a>**new GlobalVariableAnalysis**()

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
    * `heap-analysis/src/plugins/GlobalVariableAnalysis/GlobalVariableAnalysis.ts:21`

___

### <a id="getdescription"></a>**getDescription**()

 * **Returns**: `string`
 * **Source**:
    * `heap-analysis/src/plugins/GlobalVariableAnalysis/GlobalVariableAnalysis.ts:25`

___

### <a id="getoptions"></a>**getOptions**()

 * **Returns**: `default`[]
 * **Source**:
    * `heap-analysis/src/plugins/GlobalVariableAnalysis/GlobalVariableAnalysis.ts:29`

___

### <a id="process"></a>**process**(`options`)

 * **Parameters**:
    * `options`: `HeapAnalysisOptions`
 * **Returns**: `Promise`<`void`\>
 * **Source**:
    * `heap-analysis/src/plugins/GlobalVariableAnalysis/GlobalVariableAnalysis.ts:33`

___

### <a id="run"></a>**run**(`options?`)

 * **Parameters**:
    * `options`: `HeapAnalysisOptions` | `pluginUtils.defaultAnalysisArgs`
 * **Returns**: `Promise`<`any`\>
 * **Source**:
    * `heap-analysis/src/BaseAnalysis.ts:45`
