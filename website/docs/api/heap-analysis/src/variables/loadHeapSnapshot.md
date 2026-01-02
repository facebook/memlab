# Variable: loadHeapSnapshot()

> **loadHeapSnapshot**: (`options`) => `Promise`\<`IHeapSnapshot`\>

Defined in: heap-analysis/src/index.ts:26

Load the heap graph based on the single JavaScript heap snapshot
passed to the hosting heap analysis via `HeapAnalysisOptions`.

This API is supposed to be used within the `process` implementation
of an `BaseAnalysis` instance.

## Parameters

### options

[`HeapAnalysisOptions`](../type-aliases/HeapAnalysisOptions.md)

this is the auto-generated input passed to all the `BaseAnalysis` instances

## Returns

`Promise`\<`IHeapSnapshot`\>

the graph representation of the heap
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
The new heap analysis can also be used with analyze, in that case
`loadHeapSnapshot` will use the last heap snapshot in alphanumerically
ascending order from BrowserInteractionResultReader.
