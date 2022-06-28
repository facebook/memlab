---
id: "heap_analysis_src.DetachedDOMElementAnalysis"
title: "Class: DetachedDOMElementAnalysis"
sidebar_label: "DetachedDOMElementAnalysis"
custom_edit_url: null
---

[heap-analysis/src](../modules/heap_analysis_src.md).DetachedDOMElementAnalysis

## Hierarchy

- [`BaseAnalysis`](heap_analysis_src.BaseAnalysis.md)

  ↳ **`DetachedDOMElementAnalysis`**

## Constructors

### <a id="new detacheddomelementanalysis"></a>**new DetachedDOMElementAnalysis**()

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
    * `heap-analysis/src/plugins/DetachedDOMElementAnalysis.ts:20`

___

### <a id="getdescription"></a>**getDescription**()

 * **Returns**: `string`
 * **Source**:
    * `heap-analysis/src/plugins/DetachedDOMElementAnalysis.ts:24`

___

### <a id="getdetachedelements"></a>**getDetachedElements**()

 * **Returns**: `IHeapNode`[]
 * **Source**:
    * `heap-analysis/src/plugins/DetachedDOMElementAnalysis.ts:34`

___

### <a id="getoptions"></a>**getOptions**()

 * **Returns**: `default`[]
 * **Source**:
    * `heap-analysis/src/plugins/DetachedDOMElementAnalysis.ts:28`

___

### <a id="process"></a>**process**(`options`)

 * **Parameters**:
    * `options`: `HeapAnalysisOptions`
 * **Returns**: `Promise`<`void`\>
 * **Source**:
    * `heap-analysis/src/plugins/DetachedDOMElementAnalysis.ts:38`

___

### <a id="run"></a>**run**(`options?`)

 * **Parameters**:
    * `options`: `HeapAnalysisOptions` | `pluginUtils.defaultAnalysisArgs`
 * **Returns**: `Promise`<`any`\>
 * **Source**:
    * `heap-analysis/src/BaseAnalysis.ts:45`
