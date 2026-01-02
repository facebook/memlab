# Variable: getSnapshotFileForAnalysis()

> **getSnapshotFileForAnalysis**: (`options`) => `string`

Defined in: heap-analysis/src/index.ts:25

Get the heap snapshot file's absolute path passed to the hosting heap
analysis via `HeapAnalysisOptions`.

This API is supposed to be used within the overridden `process` method
of an `BaseAnalysis` instance.

## Parameters

### options

[`HeapAnalysisOptions`](../type-aliases/HeapAnalysisOptions.md)

this is the auto-generated input passed to all the `BaseAnalysis` instances

## Returns

`string`

the absolute path of the heap snapshot file
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
The new heap analysis can also be used with analyze, in that case
`getSnapshotFileForAnalysis` will use the last heap snapshot in alphanumerically
ascending order from BrowserInteractionResultReader.
