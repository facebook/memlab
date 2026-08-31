# Function: anonymizeHeapSnapshotFile()

> **anonymizeHeapSnapshotFile**(`inputFile`, `outputFile`, `options?`, `onProgress?`): `Promise`\<[`AnonymizeReport`](../type-aliases/AnonymizeReport.md)\>

Defined in: core/src/lib/HeapAnonymizer.ts:905

Anonymize a `.heapsnapshot` file and write the result to another file.

The file-to-file form of [anonymizeHeapSnapshot](anonymizeHeapSnapshot.md), and the one to reach
for when the capture is only being shared rather than analyzed here: it skips
building the object graph on the way in, and streams on the way out, so
neither the input nor the output is ever held as one string.

## Parameters

### inputFile

`string`

absolute path of the capture to read

### outputFile

`string`

absolute path to write the anonymized capture to; an
existing file at that path is overwritten

### options?

[`AnonymizeOptions`](../type-aliases/AnonymizeOptions.md) = `{}`

see [AnonymizeOptions](../type-aliases/AnonymizeOptions.md)

### onProgress?

[`AnonymizeProgressCallback`](../type-aliases/AnonymizeProgressCallback.md)

## Returns

`Promise`\<[`AnonymizeReport`](../type-aliases/AnonymizeReport.md)\>

a summary of what was redacted, and what was left in the clear; see
[AnonymizeReport](../type-aliases/AnonymizeReport.md)

* **Examples**:
```typescript
import {anonymizeHeapSnapshotFile} from '@memlab/core';

(async function () {
  const report = await anonymizeHeapSnapshotFile(
    '/tmp/capture.heapsnapshot',
    '/tmp/shareable.heapsnapshot',
  );
  console.log(`redacted ${report.valuesRedacted} string values`);
  for (const family of report.unclassifiedLabelFamilies) {
    console.log(`still in the clear: ${family.count} x ${family.shape}`);
  }
})();
```
