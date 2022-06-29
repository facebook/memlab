---
id: "heap_analysis_src.ShapeUnboundGrowthAnalysis"
title: "Class: ShapeUnboundGrowthAnalysis"
sidebar_label: "ShapeUnboundGrowthAnalysis"
custom_edit_url: null
---

[heap-analysis/src](../modules/heap_analysis_src.md).ShapeUnboundGrowthAnalysis

## Hierarchy

- [`BaseAnalysis`](heap_analysis_src.BaseAnalysis.md)

  ↳ **`ShapeUnboundGrowthAnalysis`**

## Constructors

### <a id="new shapeunboundgrowthanalysis"></a>**new ShapeUnboundGrowthAnalysis**()

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
    * heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:40

___

### <a id="getdescription"></a>**getDescription**()

 * **Returns**: `string`
 * **Source**:
    * heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:44

___

### <a id="getoptions"></a>**getOptions**()

 * **Returns**: `default`[]
 * **Source**:
    * heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:48

___

### <a id="getshapesinfo"></a>**getShapesInfo**(`snapshot`)

 * **Parameters**:
    * `snapshot`: `IHeapSnapshot`
 * **Returns**: `ShapesInfo`
 * **Source**:
    * heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:81

___

### <a id="getsummary"></a>**getSummary**(`ShapesInfoList`)

 * **Parameters**:
    * `ShapesInfoList`: `ShapesInfo`[]
 * **Returns**: `ShapeSummary`[]
 * **Source**:
    * heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:133

___

### <a id="process"></a>**process**(`options`)

 * **Parameters**:
    * `options`: `HeapAnalysisOptions`
 * **Returns**: `Promise`<`ShapeSummary`[]\>
 * **Source**:
    * heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:54

___

### <a id="run"></a>**run**(`options?`)

 * **Parameters**:
    * `options`: `HeapAnalysisOptions` | `pluginUtils.defaultAnalysisArgs`
 * **Returns**: `Promise`<`any`\>
 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:45
