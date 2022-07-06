---
id: "heap_analysis_src.ShapeUnboundGrowthAnalysis"
title: "Class: ShapeUnboundGrowthAnalysis"
sidebar_label: "ShapeUnboundGrowthAnalysis"
custom_edit_url: null
---

## Hierarchy

- [`BaseAnalysis`](heap_analysis_src.BaseAnalysis.md)

  ↳ **`ShapeUnboundGrowthAnalysis`**

## Constructors

### <a id="new shapeunboundgrowthanalysis"></a>**new ShapeUnboundGrowthAnalysis**()

## Methods

### <a id="analyzesnapshotsindirectory"></a>**analyzeSnapshotsInDirectory**(`directory`)

Run heap analysis for a series of heap snapshot files

 * **Parameters**:
    * `directory`: `string` | the absolute path of the directory holding a series of `.heapsnapshot` files, all snapshot files will be loaded and analyzed in the alphanumerically ascending order of those snapshot file names.
 * **Returns**: `Promise`<`void`\> | this API returns void. To get the analysis results,
check out the documentation of the hosting heap analysis class and
call the analysis-specific API to get results after calling this method.
* **Example**:
```typescript
const analysis = new ShapeUnboundGrowthAnalysis();
await anaysis.analyzeSnapshotsInDirectory(snapshotDirectory);
const shapes = analysis.getShapesWithUnboundGrowth();
```

 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:100

___

### <a id="getcommandname"></a>**getCommandName**()

Get the name of the heap analysis, which is also used to reference
the analysis in memlab command-line tool.

The following terminal command will initiate with this analysis:
`memlab analyze <ANALYSIS_NAME>`

 * **Returns**: `string` | the name of the analysis
* **Examples**:
```typescript
const analysis = new YourAnalysis();
const name = analysis.getCommandName();
```

 * **Source**:
    * heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:43

___

### <a id="getshapeswithunboundgrowth"></a>**getShapesWithUnboundGrowth**()

 * **Returns**: `ShapeSummary`[]
 * **Source**:
    * heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:66
