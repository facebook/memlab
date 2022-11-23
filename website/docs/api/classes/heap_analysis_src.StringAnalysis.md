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

### <a id="getcommandname"></a>**getCommandName**()

get CLI command name for this memory analysis;
use it with `memlab analyze <ANALYSIS_NAME>` in CLI

 * **Returns**: `string` | command name

 * **Source**:
    * heap-analysis/src/plugins/StringAnalysis.ts:118

___

### <a id="gettopduplicatedstringsincount"></a>**getTopDuplicatedStringsInCount**()

get the top duplicated string in terms of duplicated string count

 * **Returns**: `StringRecord`[] | an array of the top-duplicated strings' information

 * **Source**:
    * heap-analysis/src/plugins/StringAnalysis.ts:68
