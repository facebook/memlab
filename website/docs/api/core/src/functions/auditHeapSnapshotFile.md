# Function: auditHeapSnapshotFile()

> **auditHeapSnapshotFile**(`inputFile`, `options?`, `onProgress?`): `Promise`\<[`AnonymizeReport`](../type-aliases/AnonymizeReport.md)\>

Defined in: core/src/lib/HeapAnonymizer.ts:952

Report what anonymizing a capture WOULD remove, and what it would leave,
without writing anything.

Point it at a capture someone already anonymized to find out whether they
missed something: `unclassifiedLabelFamilies` names the identifier-shaped
text still in the clear. Run against one already-anonymized capture, this is
what showed its author had removed every string VALUE and left 26,303 account
handles behind as property names.

## Parameters

### inputFile

`string`

absolute path of the capture to inspect

### options?

[`AnonymizeOptions`](../type-aliases/AnonymizeOptions.md) = `{}`

see [AnonymizeOptions](../type-aliases/AnonymizeOptions.md)

### onProgress?

[`AnonymizeProgressCallback`](../type-aliases/AnonymizeProgressCallback.md)

## Returns

`Promise`\<[`AnonymizeReport`](../type-aliases/AnonymizeReport.md)\>

the same summary [anonymizeHeapSnapshotFile](anonymizeHeapSnapshotFile.md) returns, for a
run that was not written to disk

* **Examples**:
```typescript
import {auditHeapSnapshotFile} from '@memlab/core';

(async function () {
  const report = await auditHeapSnapshotFile('/tmp/shared.heapsnapshot');
  console.log(report.unclassifiedLabelFamilies);
})();
```
