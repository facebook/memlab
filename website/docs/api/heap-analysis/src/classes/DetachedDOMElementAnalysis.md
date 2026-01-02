# Class: DetachedDOMElementAnalysis

Defined in: heap-analysis/src/plugins/DetachedDOMElementAnalysis.ts:20

## Extends

- [`BaseAnalysis`](BaseAnalysis.md)

## Constructors

### Constructor

> **new DetachedDOMElementAnalysis**(): `DetachedDOMElementAnalysis`

#### Returns

`DetachedDOMElementAnalysis`

#### Inherited from

[`BaseAnalysis`](BaseAnalysis.md).[`constructor`](BaseAnalysis.md#constructor)

## Methods

### analyzeSnapshotFromFile()

> **analyzeSnapshotFromFile**(`file`, `options`): `Promise`\<[`AnalyzeSnapshotResult`](../type-aliases/AnalyzeSnapshotResult.md)\>

Defined in: heap-analysis/src/BaseAnalysis.ts:95

Run heap analysis for a single heap snapshot file

#### Parameters

##### file

`string`

the absolute path of a `.heapsnapshot` file.

##### options

[`RunHeapAnalysisOptions`](../type-aliases/RunHeapAnalysisOptions.md) = `{}`

optional configuration for the heap analysis run

#### Returns

`Promise`\<[`AnalyzeSnapshotResult`](../type-aliases/AnalyzeSnapshotResult.md)\>

this API returns [AnalyzeSnapshotResult](../type-aliases/AnalyzeSnapshotResult.md), which contains
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

#### Inherited from

[`BaseAnalysis`](BaseAnalysis.md).[`analyzeSnapshotFromFile`](BaseAnalysis.md#analyzesnapshotfromfile)

***

### getCommandName()

> **getCommandName**(): `string`

Defined in: heap-analysis/src/plugins/DetachedDOMElementAnalysis.ts:21

Get the name of the heap analysis, which is also used to reference
the analysis in memlab command-line tool.

The following terminal command will initiate with this analysis:
`memlab analyze <ANALYSIS_NAME>`

#### Returns

`string`

the name of the analysis
* **Examples**:
```typescript
const analysis = new YourAnalysis();
const name = analysis.getCommandName();
```

#### Overrides

[`BaseAnalysis`](BaseAnalysis.md).[`getCommandName`](BaseAnalysis.md#getcommandname)

***

### getDetachedElements()

> **getDetachedElements**(): `IHeapNode`[]

Defined in: heap-analysis/src/plugins/DetachedDOMElementAnalysis.ts:48

#### Returns

`IHeapNode`[]
