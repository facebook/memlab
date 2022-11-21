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

### <a id="analyzesnapshotfromfile"></a>**analyzeSnapshotFromFile**(`file`)

Run heap analysis for a single heap snapshot file

 * **Parameters**:
    * `file`: `string` | the absolute path of a `.heapsnapshot` file.
 * **Returns**: `Promise`<`AnalyzeSnapshotResult`\> | this API returns {@link AnalyzeSnapshotResult}, which contains
the logging file of analysis console output. Alternatively, to get more
structured analysis results, check out the documentation of the hosting
heap analysis class and call the analysis-specific API to get results
after calling this method.
* **Example**:
```typescript
const analysis = new StringAnalysis();
// analysis console output is saved in result.analysisOutputFile
const result = await anaysis.analyzeSnapshotFromFile(snapshotFile);
// query analysis-specific and structured results
const stringPatterns = analysis.getTopDuplicatedStringsInCount();
```

 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:79

___

### <a id="analyzesnapshotsindirectory"></a>**analyzeSnapshotsInDirectory**(`directory`)

Run heap analysis for a series of heap snapshot files

 * **Parameters**:
    * `directory`: `string` | the absolute path of the directory holding a series of `.heapsnapshot` files, all snapshot files will be loaded and analyzed in the alphanumerically ascending order of those snapshot file names.
 * **Returns**: `Promise`<`AnalyzeSnapshotResult`\> | this API returns {@link AnalyzeSnapshotResult}, which contains
the logging file of analysis console output. Alternatively, to get more
structured analysis results, check out the documentation of the hosting
heap analysis class and call the analysis-specific API to get results
after calling this method.
* **Example**:
```typescript
const analysis = new ShapeUnboundGrowthAnalysis();
// analysis console output is saved in result.analysisOutputFile
const result = await anaysis.analyzeSnapshotsInDirectory(snapshotDirectory);
// query analysis-specific and structured results
const shapes = analysis.getShapesWithUnboundGrowth();
```

 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:114

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
    * heap-analysis/src/BaseAnalysis.ts:149

___

### <a id="getdescription"></a>**getDescription**()

Get the textual description of the heap analysis.
The description of this analysis will be printed by:
`memlab analyze list`

 * **Returns**: `string` | the description

 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:161

___

### <a id="getoptions"></a>**getOptions**()

override this method if you would like CLI to print the option info

 * **Returns**: `default`[] | an array of command line options

 * **Source**:
    * heap-analysis/src/BaseAnalysis.ts:188

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
    * heap-analysis/src/BaseAnalysis.ts:176
