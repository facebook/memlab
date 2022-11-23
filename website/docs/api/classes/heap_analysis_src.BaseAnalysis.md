---
id: "heap_analysis_src.BaseAnalysis"
title: "Class: BaseAnalysis"
sidebar_label: "BaseAnalysis"
custom_edit_url: null
---

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

### <a id="analyzesnapshotfromfile"></a>**analyzeSnapshotFromFile**(`file`, `options?`)

Run heap analysis for a single heap snapshot file

 * **Parameters**:
    * `file`: `string` | the absolute path of a `.heapsnapshot` file.
    * `options`: [`RunHeapAnalysisOptions`](../modules/heap_analysis_src.md#runheapanalysisoptions) | optional configuration for the heap analysis run
 * **Returns**: `Promise`<[`AnalyzeSnapshotResult`](../modules/heap_analysis_src.md#analyzesnapshotresult)\> | this API returns [AnalyzeSnapshotResult](../modules/heap_analysis_src.md#analyzesnapshotresult), which contains
the logging file of analysis console output. Alternatively, to get more
structured analysis results, check out the documentation of the hosting
heap analysis class and call the analysis-specific API to get results
after calling this method.
* **Example**:
```typescript
const analysis = new StringAnalysis();
// analysis console output is saved in result.analysisOutputFile
const result = await analysis.analyzeSnapshotFromFile(snapshotFile);
// query analysis-specific and structured results
const stringPatterns = analysis.getTopDuplicatedStringsInCount();
```
Additionally, you can specify a working directory to where
the intermediate, logging, and final output files will be dumped:
```typescript
const analysis = new StringAnalysis();
// analysis console output is saved in result.analysisOutputFile
// which is inside the specified working directory
const result = await analysis.analyzeSnapshotFromFile(snapshotFile, {
  // if the specified directory doesn't exist, memlab will create it
  workDir: '/tmp/your/work/dir',
});
```

 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:95

___

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
    * heap-analysis/src/BaseAnalysis.ts:189

___

### <a id="getdescription"></a>**getDescription**()

Get the textual description of the heap analysis.
The description of this analysis will be printed by:
`memlab analyze list`

 * **Returns**: `string` | the description

 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:201

___

### <a id="getoptions"></a>**getOptions**()

override this method if you would like CLI to print the option info

 * **Returns**: `default`[] | an array of command line options

 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:228

___

### <a id="process"></a>**process**(`options`)

Callback for `memlab analyze <command-name>`.
Do the memory analysis and print results in this callback
The analysis should support:
 1) printing results on screen
 2) returning results via the return value

 * **Parameters**:
    * `options`: [`HeapAnalysisOptions`](../modules/heap_analysis_src.md#heapanalysisoptions) | This is the auto-generated arguments passed to all the `process` method that your self-defined heap analysis should implement. You are not supposed to construct instances of this class.
 * **Returns**: `Promise`<`any`\>
 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:216
