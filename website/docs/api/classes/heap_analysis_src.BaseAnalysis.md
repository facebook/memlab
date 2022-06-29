---
id: "heap_analysis_src.BaseAnalysis"
title: "Class: BaseAnalysis"
sidebar_label: "BaseAnalysis"
custom_edit_url: null
---

[heap-analysis/src](../modules/heap_analysis_src.md).BaseAnalysis

## Hierarchy

- `Analysis`

  ↳ **`BaseAnalysis`**

  ↳↳ [`DetachedDOMElementAnalysis`](heap_analysis_src.DetachedDOMElementAnalysis.md)

  ↳↳ [`GlobalVariableAnalysis`](heap_analysis_src.GlobalVariableAnalysis.md)

  ↳↳ [`CollectionsHoldingStaleAnalysis`](heap_analysis_src.CollectionsHoldingStaleAnalysis.md)

  ↳↳ [`ObjectShallowAnalysis`](heap_analysis_src.ObjectShallowAnalysis.md)

  ↳↳ [`ObjectSizeAnalysis`](heap_analysis_src.ObjectSizeAnalysis.md)

  ↳↳ [`ShapeUnboundGrowthAnalysis`](heap_analysis_src.ShapeUnboundGrowthAnalysis.md)

  ↳↳ [`ObjectFanoutAnalysis`](heap_analysis_src.ObjectFanoutAnalysis.md)

  ↳↳ [`ObjectShapeAnalysis`](heap_analysis_src.ObjectShapeAnalysis.md)

  ↳↳ [`ObjectUnboundGrowthAnalysis`](heap_analysis_src.ObjectUnboundGrowthAnalysis.md)

  ↳↳ [`StringAnalysis`](heap_analysis_src.StringAnalysis.md)

## Constructors

### <a id="new baseanalysis"></a>**new BaseAnalysis**()

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
    * heap-analysis/src/BaseAnalysis.ts:78

___

### <a id="getdescription"></a>**getDescription**()

 * **Returns**: `string`
 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:85

___

### <a id="getoptions"></a>**getOptions**()

 * **Returns**: `default`[]
 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:104

___

### <a id="run"></a>**run**(`options?`)

 * **Parameters**:
    * `options`: `HeapAnalysisOptions` | `pluginUtils.defaultAnalysisArgs`
 * **Returns**: `Promise`<`any`\>
 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:45
