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

### <a id="analyzesnapshotsindirectory"></a>**analyzeSnapshotsInDirectory**(`directory`, `options?`)

Run heap analysis for a series of heap snapshot files

 * **Parameters**:
    * `directory`: `string` | the absolute path of the directory holding a series of `.heapsnapshot` files, all snapshot files will be loaded and analyzed in the alphanumerically ascending order of those snapshot file names.
    * `options`: [`RunHeapAnalysisOptions`](../modules/heap_analysis_src.md#runheapanalysisoptions) | optional configuration for the heap analysis run
 * **Returns**: `Promise`<[`AnalyzeSnapshotResult`](../modules/heap_analysis_src.md#analyzesnapshotresult)\> | this API returns [AnalyzeSnapshotResult](../modules/heap_analysis_src.md#analyzesnapshotresult), which contains
the logging file of analysis console output. Alternatively, to get more
structured analysis results, check out the documentation of the hosting
heap analysis class and call the analysis-specific API to get results
after calling this method.
* **Example**:
```typescript
const analysis = new ShapeUnboundGrowthAnalysis();
// analysis console output is saved in result.analysisOutputFile
const result = await analysis.analyzeSnapshotsInDirectory(snapshotDirectory);
// query analysis-specific and structured results
const shapes = analysis.getShapesWithUnboundGrowth();
```
* Additionally, you can specify a working directory to where
the intermediate, logging, and final output files will be dumped:
```typescript
const analysis = new ShapeUnboundGrowthAnalysis();
// analysis console output is saved in result.analysisOutputFile
// which is inside the specified working directory
const result = await analysis.analyzeSnapshotsInDirectory(snapshotDirectory, {
  // if the specified directory doesn't exist, memlab will create it
  workDir: '/tmp/your/work/dir',
});
```

 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:148

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
    * heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:71
