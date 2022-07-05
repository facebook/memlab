---
id: "heap_analysis_src.ObjectFanoutAnalysis"
title: "Class: ObjectFanoutAnalysis"
sidebar_label: "ObjectFanoutAnalysis"
custom_edit_url: null
---

## Hierarchy

- [`BaseAnalysis`](heap_analysis_src.BaseAnalysis.md)

  ↳ **`ObjectFanoutAnalysis`**

## Constructors

### <a id="new objectfanoutanalysis"></a>**new ObjectFanoutAnalysis**()

## Methods

### <a id="analyzesnapshotfromfile"></a>**analyzeSnapshotFromFile**(`file`)

 * **Parameters**:
    * `file`: `string`
 * **Returns**: `Promise`<`any`\>
 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:52

___

### <a id="analyzesnapshotsindirectory"></a>**analyzeSnapshotsInDirectory**(`directory`)

 * **Parameters**:
    * `directory`: `string`
 * **Returns**: `Promise`<`any`\>
 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:62

___

### <a id="getcommandname"></a>**getCommandName**()

 * **Returns**: `string`
 * **Source**:
    * heap-analysis/src/plugins/ObjectFanoutAnalysis.ts:21

___

### <a id="getdescription"></a>**getDescription**()

 * **Returns**: `string`
 * **Source**:
    * heap-analysis/src/plugins/ObjectFanoutAnalysis.ts:25

___

### <a id="getoptions"></a>**getOptions**()

 * **Returns**: `default`[]
 * **Source**:
    * heap-analysis/src/plugins/ObjectFanoutAnalysis.ts:29

___

### <a id="process"></a>**process**(`options`)

 * **Parameters**:
    * `options`: [`HeapAnalysisOptions`](../modules/heap_analysis_src.md#heapanalysisoptions)
 * **Returns**: `Promise`<`void`\>
 * **Source**:
    * heap-analysis/src/plugins/ObjectFanoutAnalysis.ts:33

___

### <a id="run"></a>**run**(`options?`)

 * **Parameters**:
    * `options`: [`HeapAnalysisOptions`](../modules/heap_analysis_src.md#heapanalysisoptions) | `pluginUtils.defaultAnalysisArgs`
 * **Returns**: `Promise`<`any`\>
 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:45
