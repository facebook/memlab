# Class: ShapeUnboundGrowthAnalysis

Defined in: heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:39

## Extends

- [`BaseAnalysis`](BaseAnalysis.md)

## Constructors

### Constructor

> **new ShapeUnboundGrowthAnalysis**(): `ShapeUnboundGrowthAnalysis`

#### Returns

`ShapeUnboundGrowthAnalysis`

#### Inherited from

[`BaseAnalysis`](BaseAnalysis.md).[`constructor`](BaseAnalysis.md#constructor)

## Methods

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

[`BaseAnalysis`](BaseAnalysis.md).[`analyzeSnapshotsInDirectory`](BaseAnalysis.md#analyzesnapshotsindirectory)

***

### getCommandName()

> **getCommandName**(): `string`

Defined in: heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:43

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

### getShapesWithUnboundGrowth()

> **getShapesWithUnboundGrowth**(): `ShapeSummary`[]

Defined in: heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:71

#### Returns

`ShapeSummary`[]
