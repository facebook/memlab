---
id: "heap_analysis_src"
title: "Package: @memlab/heap-analysis"
sidebar_label: "heap-analysis/src"
sidebar_position: 0
custom_edit_url: null
---

## Classes

- [BaseAnalysis](../classes/heap_analysis_src.BaseAnalysis.md)
- [CollectionsHoldingStaleAnalysis](../classes/heap_analysis_src.CollectionsHoldingStaleAnalysis.md)
- [DetachedDOMElementAnalysis](../classes/heap_analysis_src.DetachedDOMElementAnalysis.md)
- [GlobalVariableAnalysis](../classes/heap_analysis_src.GlobalVariableAnalysis.md)
- [ObjectFanoutAnalysis](../classes/heap_analysis_src.ObjectFanoutAnalysis.md)
- [ObjectShallowAnalysis](../classes/heap_analysis_src.ObjectShallowAnalysis.md)
- [ObjectShapeAnalysis](../classes/heap_analysis_src.ObjectShapeAnalysis.md)
- [ObjectSizeAnalysis](../classes/heap_analysis_src.ObjectSizeAnalysis.md)
- [ObjectUnboundGrowthAnalysis](../classes/heap_analysis_src.ObjectUnboundGrowthAnalysis.md)
- [ShapeUnboundGrowthAnalysis](../classes/heap_analysis_src.ShapeUnboundGrowthAnalysis.md)
- [StringAnalysis](../classes/heap_analysis_src.StringAnalysis.md)

## Type Aliases

### <a id="heapanalysisoptions" name="heapanalysisoptions"></a> **HeapAnalysisOptions**: `Object`

This is the auto-generated arguments passed to all the `process` method
that your self-defined heap analysis should implement.
You are not supposed to construct instances of this class.

For code examples on how this options could be used, see
[getSnapshotFileForAnalysis](heap_analysis_src.md#getsnapshotfileforanalysis), [loadHeapSnapshot](heap_analysis_src.md#loadheapsnapshot),
or [snapshotMapReduce](heap_analysis_src.md#snapshotmapreduce).

 * **Source**:
    * heap-analysis/src/PluginUtils.ts:68

## Functions

### <a id="getdominatornodes"></a>**getDominatorNodes**(`ids`, `snapshot`)

This API calculate the set of
[dominator nodes](https://firefox-source-docs.mozilla.org/devtools-user/memory/dominators/index.html)
of the set of input heap objects.

 * **Parameters**:
    * `ids`: `Set`<`number`\> | Set of ids of heap objects (or nodes)
    * `snapshot`: `IHeapSnapshot` | heap loaded from a heap snapshot
 * **Returns**: `Set`<`number`\> | the set of dominator nodes/objects
* * **Examples**:
```typescript
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile, getDominatorNodes} from '@memlab/heap-analysis';

class TestObject {}

(async function () {
  const t1 = new TestObject();
  const t2 = new TestObject();

  // dump the heap of this running JavaScript program
  const heapFile = dumpNodeHeapSnapshot();
  const heap = await getFullHeapFromFile(heapFile);

  // find the heap node for TestObject
  let nodes = [];
  heap.nodes.forEach(node => {
    if (node.name === 'TestObject' && node.type === 'object') {
      nodes.push(node);
    }
  });

  // get the dominator nodes
  const dominatorIds = getDominatorNodes(
    new Set(nodes.map(node => node.id)),
    heap,
  );
})();
```

 * **Source**:
    * heap-analysis/src/PluginUtils.ts:664

___

### <a id="getfullheapfromfile"></a>**getFullHeapFromFile**(`file`)

Load and parse a `.heapsnapshot` file and calculate meta data like
dominator nodes and retained sizes.

 * **Parameters**:
    * `file`: `string` | the absolute path of the `.heapsnapshot` file
 * **Returns**: `Promise`<`IHeapSnapshot`\> | the heap graph representation instance that supports querying
the heap
* **Examples**:
```typescript
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function (){
  const heapFile = dumpNodeHeapSnapshot();
  const heap = await getFullHeapFromFile(heapFile);
})();
```

 * **Source**:
    * heap-analysis/src/PluginUtils.ts:461

___

### <a id="getheapfromfile"></a>**getHeapFromFile**(`file`)

**`deprecated`**

 * **Parameters**:
    * `file`: `string`
 * **Returns**: `Promise`<`IHeapSnapshot`\>
 * **Source**:
    * heap-analysis/src/PluginUtils.ts:492

___

### <a id="getsnapshotdirforanalysis"></a>**getSnapshotDirForAnalysis**(`options`)

Get the absolute path of the directory holding all the heap snapshot files
passed to the hosting heap analysis via `HeapAnalysisOptions`.

This API is supposed to be used within the overridden `process` method
of an `BaseAnalysis` instance.

 * **Parameters**:
    * `options`: [`HeapAnalysisOptions`](heap_analysis_src.md#heapanalysisoptions) | this is the auto-generated input passed to all the `BaseAnalysis` instances
 * **Returns**: `Nullable`<`string`\> | the absolute path of the directory
* **Examples:**
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import type {HeapAnalysisOptions} from '@memlab/heap-analysis';
import {getSnapshotFileForAnalysis, BaseAnalysis} from '@memlab/heap-analysis';

class ExampleAnalysis extends BaseAnalysis {
  public getCommandName(): string {
    return 'example-analysis';
  }

  public getDescription(): string {
    return 'an example analysis for demo';
  }

  async process(options: HeapAnalysisOptions): Promise<void> {
    const directory = getSnapshotDirForAnalysis(options);
  }
}
```

Use the following code to invoke the heap analysis:
```typescript
const analysis = new ExampleAnalysis();
// any .heapsnapshot file recorded by memlab or saved manually from Chrome
await analysis.analyzeSnapshotFromFile(snapshotFile);
```
The new heap analysis can also be used with [analyze](api_src.md#analyze), in that case
`getSnapshotDirForAnalysis` use the snapshot directory from
[BrowserInteractionResultReader](../classes/api_src.BrowserInteractionResultReader.md).

 * **Source**:
    * heap-analysis/src/PluginUtils.ts:373

___

### <a id="getsnapshotfileforanalysis"></a>**getSnapshotFileForAnalysis**(`options`)

Get the heap snapshot file's absolute path passed to the hosting heap
analysis via `HeapAnalysisOptions`.

This API is supposed to be used within the overridden `process` method
of an `BaseAnalysis` instance.

 * **Parameters**:
    * `options`: [`HeapAnalysisOptions`](heap_analysis_src.md#heapanalysisoptions) | this is the auto-generated input passed to all the `BaseAnalysis` instances
 * **Returns**: `string` | the absolute path of the heap snapshot file
* **Examples:**
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import type {HeapAnalysisOptions} from '@memlab/heap-analysis';
import {getSnapshotFileForAnalysis, BaseAnalysis} from '@memlab/heap-analysis';

class ExampleAnalysis extends BaseAnalysis {
  public getCommandName(): string {
    return 'example-analysis';
  }

  public getDescription(): string {
    return 'an example analysis for demo';
  }

  async process(options: HeapAnalysisOptions): Promise<void> {
    const file = getSnapshotFileForAnalysis(options);
  }
}
```

Use the following code to invoke the heap analysis:
```typescript
const analysis = new ExampleAnalysis();
// any .heapsnapshot file recorded by memlab or saved manually from Chrome
await analysis.analyzeSnapshotFromFile(snapshotFile);
```
The new heap analysis can also be used with [analyze](api_src.md#analyze), in that case
`getSnapshotFileForAnalysis` will use the last heap snapshot in alphanumerically
ascending order from [BrowserInteractionResultReader](../classes/api_src.BrowserInteractionResultReader.md).

 * **Source**:
    * heap-analysis/src/PluginUtils.ts:324

___

### <a id="loadheapsnapshot"></a>**loadHeapSnapshot**(`options`)

Load the heap graph based on the single JavaScript heap snapshot
passed to the hosting heap analysis via `HeapAnalysisOptions`.

This API is supposed to be used within the `process` implementation
of an `BaseAnalysis` instance.

 * **Parameters**:
    * `options`: [`HeapAnalysisOptions`](heap_analysis_src.md#heapanalysisoptions) | this is the auto-generated input passed to all the `BaseAnalysis` instances
 * **Returns**: `Promise`<`IHeapSnapshot`\> | the graph representation of the heap
* **Examples:**
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import type {HeapAnalysisOptions} from '@memlab/heap-analysis';
import {loadHeapSnapshot, BaseAnalysis} from '@memlab/heap-analysis';

class ExampleAnalysis extends BaseAnalysis {
  public getCommandName(): string {
    return 'example-analysis';
  }

  public getDescription(): string {
    return 'an example analysis for demo';
  }

  async process(options: HeapAnalysisOptions): Promise<void> {
    const heap = await loadHeapSnapshot(options);
    // doing heap analysis
  }
}
```

Use the following code to invoke the heap analysis:
```typescript
const analysis = new ExampleAnalysis();
// any .heapsnapshot file recorded by memlab or saved manually from Chrome
await analysis.analyzeSnapshotFromFile(snapshotFile);
```
The new heap analysis can also be used with [analyze](api_src.md#analyze), in that case
`loadHeapSnapshot` will use the last heap snapshot in alphanumerically
ascending order from [BrowserInteractionResultReader](../classes/api_src.BrowserInteractionResultReader.md).

 * **Source**:
    * heap-analysis/src/PluginUtils.ts:427

___

### <a id="snapshotmapreduce"></a>**snapshotMapReduce**<`T1`, `T2`\>(`mapCallback`, `reduceCallback`, `options`)

When a heap analysis is taking multiple heap snapshots as input for memory
analysis (e.g., finding which object keeps growing in size in a series of
heap snapshots), this API could be used to do
[MapRedue](https://en.wikipedia.org/wiki/MapReduce) on all heap snapshots.

This API is supposed to be used within the `process` implementation
of an `BaseAnalysis` instance that is designed to analyze multiple heap
snapshots (as an example, finding which object keeps growing overtime)

#### Type parameters

| Name | Description |
| :------ | :------ |
| `T1` | the type of the intermediate result from each map function call |
| `T2` | the type of the final result of the reduce function call |

 * **Parameters**:
    * `mapCallback`: (`snapshot`: `IHeapSnapshot`, `i`: `number`, `file`: `string`) => `T1` | the map function in MapReduce, the function will be applied to each heap snapshot
    * `reduceCallback`: (`results`: `T1`[]) => `T2` | the reduce function in MapReduce, the function will take as input all intermediate results from all map function calls
    * `options`: [`HeapAnalysisOptions`](heap_analysis_src.md#heapanalysisoptions) | this is the auto-generated input passed to all the `BaseAnalysis` instances
 * **Returns**: `Promise`<`T2`\> | the return value of your reduce function
* **Examples:**
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import type {HeapAnalysisOptions} from '@memlab/heap-analysis';
import {snapshotMapReduce, BaseAnalysis} from '@memlab/heap-analysis';

class ExampleAnalysis extends BaseAnalysis {
  public getCommandName(): string {
    return 'example-analysis';
  }

  public getDescription(): string {
    return 'an example analysis for demo';
  }

  async process(options: HeapAnalysisOptions): Promise<void> {
    // check if the number of heap objects keeps growing overtime
    const isMonotonicIncreasing = await snapshotMapReduce(
      (heap) => heap.nodes.length,
      (nodeCounts) =>
        nodeCounts[0] < nodeCounts[nodeCounts.length - 1] &&
        nodeCounts.every((count, i) => i === 0 || count >= nodeCounts[i - 1]),
      options,
    );
  }
}
```

Use the following code to invoke the heap analysis:
```typescript
const analysis = new ExampleAnalysis();
// snapshotDir includes a series of .heapsnapshot files recorded by
// memlab or saved manually from Chrome, those files will be loaded
// in alphanumerically asceneding order
await analysis.analyzeSnapshotsInDirectory(snapshotDir);
```
The new heap analysis can also be used with [analyze](api_src.md#analyze), in that case
`snapshotMapReduce` will use all the heap snapshot in alphanumerically
ascending order from [BrowserInteractionResultReader](../classes/api_src.BrowserInteractionResultReader.md).

**Why not passing in all heap snapshots as an array of [IHeapSnapshot](../interfaces/core_src.IHeapSnapshot.md)s?**
Each heap snapshot could be non-trivial in size, loading them all at once
may not be possible.

 * **Source**:
    * heap-analysis/src/PluginUtils.ts:569

___

### <a id="takenodefullheap"></a>**takeNodeFullHeap**()

Take a heap snapshot of the current program state
and parse it as [IHeapSnapshot](../interfaces/core_src.IHeapSnapshot.md). This
API also calculates some heap analysis meta data
for heap analysis. But this also means slower heap parsing
comparing with [takeNodeMinimalHeap](core_src.md#takenodeminimalheap).

 * **Returns**: `Promise`<`IHeapSnapshot`\> | heap representation with heap analysis meta data.

* **Examples:**
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import type {takeNodeFullHeap} from '@memlab/heap-analysis';

(async function () {
  const heap: IHeapSnapshot = await takeNodeFullHeap();
})();
```

 * **Source**:
    * heap-analysis/src/PluginUtils.ts:484
