# Variable: getSnapshotDirForAnalysis()

> **getSnapshotDirForAnalysis**: (`options`) => `Nullable`\<`string`\>

Defined in: heap-analysis/src/index.ts:24

Get the absolute path of the directory holding all the heap snapshot files
passed to the hosting heap analysis via `HeapAnalysisOptions`.

This API is supposed to be used within the overridden `process` method
of an `BaseAnalysis` instance.

## Parameters

### options

[`HeapAnalysisOptions`](../type-aliases/HeapAnalysisOptions.md)

this is the auto-generated input passed
to all the `BaseAnalysis` instances

## Returns

`Nullable`\<`string`\>

the absolute path of the directory
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
The new heap analysis can also be used with analyze, in that case
`getSnapshotDirForAnalysis` use the snapshot directory from
BrowserInteractionResultReader.
