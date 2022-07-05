---
id: "heap_analysis_src.ObjectShallowAnalysis"
title: "Class: ObjectShallowAnalysis"
sidebar_label: "ObjectShallowAnalysis"
custom_edit_url: null
---

## Hierarchy

- [`BaseAnalysis`](heap_analysis_src.BaseAnalysis.md)

  ↳ **`ObjectShallowAnalysis`**

## Constructors

### <a id="new objectshallowanalysis"></a>**new ObjectShallowAnalysis**()

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

get CLI command name for this memory analysis;
use it with `memlab analyze <ANALYSIS_NAME>` in CLI

 * **Returns**: `string` | command name

 * **Source**:
    * heap-analysis/src/plugins/ObjectShallowAnalysis.ts:65

___

### <a id="getdescription"></a>**getDescription**()

get a textual description of the memory analysis

 * **Returns**: `string` | textual description

 * **Source**:
    * heap-analysis/src/plugins/ObjectShallowAnalysis.ts:73

___

### <a id="gettopduplicatedobjectincount"></a>**getTopDuplicatedObjectInCount**()

get the top duplicated object in terms of duplicated object count

 * **Returns**: `ObjectRecord`[] | an array of the top-duplicated objects' information

 * **Source**:
    * heap-analysis/src/plugins/ObjectShallowAnalysis.ts:96

___

### <a id="run"></a>**run**(`options?`)

 * **Parameters**:
    * `options`: [`HeapAnalysisOptions`](../modules/heap_analysis_src.md#heapanalysisoptions) | `pluginUtils.defaultAnalysisArgs`
 * **Returns**: `Promise`<`any`\>
 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:45
