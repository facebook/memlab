---
id: "heap_analysis_src.StringAnalysis"
title: "Class: StringAnalysis"
sidebar_label: "StringAnalysis"
custom_edit_url: null
---

This analysis finds duplicated string instance in JavaScript heap
and rank them based on the duplicated string size and count.

## Hierarchy

- [`BaseAnalysis`](heap_analysis_src.BaseAnalysis.md)

  ↳ **`StringAnalysis`**

## Constructors

### <a id="new stringanalysis"></a>**new StringAnalysis**()

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
    * heap-analysis/src/plugins/StringAnalysis.ts:124

___

### <a id="getdescription"></a>**getDescription**()

get a textual description of the memory analysis

 * **Returns**: `string` | textual description

 * **Source**:
    * heap-analysis/src/plugins/StringAnalysis.ts:132

___

### <a id="gettopduplicatedstringsincount"></a>**getTopDuplicatedStringsInCount**()

get the top duplicated string in terms of duplicated string count

 * **Returns**: `StringRecord`[] | an array of the top-duplicated strings' information

 * **Source**:
    * heap-analysis/src/plugins/StringAnalysis.ts:73

___

### <a id="run"></a>**run**(`options?`)

 * **Parameters**:
    * `options`: [`HeapAnalysisOptions`](../modules/heap_analysis_src.md#heapanalysisoptions) | `pluginUtils.defaultAnalysisArgs`
 * **Returns**: `Promise`<`any`\>
 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:45
