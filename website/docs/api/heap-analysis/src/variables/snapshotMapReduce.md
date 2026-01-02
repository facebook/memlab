# Variable: snapshotMapReduce()

> **snapshotMapReduce**: \<`T1`, `T2`\>(`mapCallback`, `reduceCallback`, `options`) => `Promise`\<`T2`\>

Defined in: heap-analysis/src/index.ts:27

When a heap analysis is taking multiple heap snapshots as input for memory
analysis (e.g., finding which object keeps growing in size in a series of
heap snapshots), this API could be used to do
[MapRedue](https://en.wikipedia.org/wiki/MapReduce) on all heap snapshots.

This API is supposed to be used within the `process` implementation
of an `BaseAnalysis` instance that is designed to analyze multiple heap
snapshots (as an example, finding which object keeps growing overtime)

## Type Parameters

### T1

`T1`

the type of the intermediate result from each map function call

### T2

`T2`

the type of the final result of the reduce function call

## Parameters

### mapCallback

(`snapshot`, `i`, `file`) => `T1`

the map function in MapReduce, the function will be applied
to each heap snapshot

### reduceCallback

(`results`) => `T2`

the reduce function in MapReduce, the function will take
as input all intermediate results from all map function calls

### options

[`HeapAnalysisOptions`](../type-aliases/HeapAnalysisOptions.md)

this is the auto-generated input passed to all the `BaseAnalysis` instances

## Returns

`Promise`\<`T2`\>

the return value of your reduce function
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
// in alphanumerically ascending order
await analysis.analyzeSnapshotsInDirectory(snapshotDir);
```
The new heap analysis can also be used with analyze, in that case
`snapshotMapReduce` will use all the heap snapshot in alphanumerically
ascending order from BrowserInteractionResultReader.

**Why not passing in all heap snapshots as an array of IHeapSnapshots?**
Each heap snapshot could be non-trivial in size, loading them all at once
may not be possible.
