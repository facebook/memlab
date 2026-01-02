# Class: BaseAnalysis

Defined in: heap-analysis/src/BaseAnalysis.ts:174

## Extends

- `Analysis`

## Extended by

- [`DetachedDOMElementAnalysis`](DetachedDOMElementAnalysis.md)
- [`GlobalVariableAnalysis`](GlobalVariableAnalysis.md)
- [`CollectionsHoldingStaleAnalysis`](CollectionsHoldingStaleAnalysis.md)
- [`ObjectShallowAnalysis`](ObjectShallowAnalysis.md)
- [`ObjectSizeAnalysis`](ObjectSizeAnalysis.md)
- [`ShapeUnboundGrowthAnalysis`](ShapeUnboundGrowthAnalysis.md)
- [`ObjectFanoutAnalysis`](ObjectFanoutAnalysis.md)
- [`ObjectShapeAnalysis`](ObjectShapeAnalysis.md)
- [`ObjectUnboundGrowthAnalysis`](ObjectUnboundGrowthAnalysis.md)
- [`StringAnalysis`](StringAnalysis.md)

## Constructors

### Constructor

> **new BaseAnalysis**(): `BaseAnalysis`

#### Returns

`BaseAnalysis`

#### Inherited from

`Analysis.constructor`

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

`Analysis.analyzeSnapshotFromFile`

***

### analyzeSnapshotsInDirectory()

> **analyzeSnapshotsInDirectory**(`directory`, `options`): `Promise`\<[`AnalyzeSnapshotResult`](../type-aliases/AnalyzeSnapshotResult.md)\>

Defined in: heap-analysis/src/BaseAnalysis.ts:148

Run heap analysis for a series of heap snapshot files

#### Parameters

##### directory

`string`

the absolute path of the directory holding a series of
`.heapsnapshot` files, all snapshot files will be loaded and analyzed
in the alphanumerically ascending order of those snapshot file names.

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

#### Inherited from

`Analysis.analyzeSnapshotsInDirectory`

***

### getCommandName()

> **getCommandName**(): `string`

Defined in: heap-analysis/src/BaseAnalysis.ts:189

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

***

### getDescription()

> **getDescription**(): `string`

Defined in: heap-analysis/src/BaseAnalysis.ts:201

Get the textual description of the heap analysis.
The description of this analysis will be printed by:
`memlab analyze list`

#### Returns

`string`

the description

***

### getOptions()

> **getOptions**(): `BaseOption`[]

Defined in: heap-analysis/src/BaseAnalysis.ts:228

override this method if you would like CLI to print the option info

#### Returns

`BaseOption`[]

an array of command line options

***

### process()

> **process**(`options`): `Promise`\<`any`\>

Defined in: heap-analysis/src/BaseAnalysis.ts:216

Callback for `memlab analyze <command-name>`.
Do the memory analysis and print results in this callback
The analysis should support:
 1) printing results on screen
 2) returning results via the return value

#### Parameters

##### options

[`HeapAnalysisOptions`](../type-aliases/HeapAnalysisOptions.md)

This is the auto-generated arguments passed to all the
`process` method that your self-defined heap analysis should implement.
You are not supposed to construct instances of this class.

#### Returns

`Promise`\<`any`\>

#### Overrides

`Analysis.process`
