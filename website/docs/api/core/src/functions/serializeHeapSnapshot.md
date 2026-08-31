# Function: serializeHeapSnapshot()

> **serializeHeapSnapshot**(`snapshot`, `outputFile`): `void`

Defined in: core/src/lib/HeapSerializer.ts:346

Write a parsed (and possibly modified) heap snapshot to a `.heapsnapshot`
file that Chrome DevTools, memlab and any other V8 snapshot reader can open.

This is the inverse of parsing, and it makes "load a snapshot, change it,
save it" a supported workflow — [anonymizeHeapSnapshot](anonymizeHeapSnapshot.md) is one such
consumer.

Edits made through the snapshot's underlying data are picked up
automatically: node names are read out of the string table on every access
rather than cached, so a rewritten string table is already what the
in-memory snapshot reports.

The file is streamed out through a single fixed buffer, one array element at
a time. That is a hard requirement rather than an optimization: V8 caps a
string at 512 MB (`buffer.constants.MAX_STRING_LENGTH`), so building the
document — or even one of its larger arrays — as a string throws
`RangeError: Invalid string length` on a large capture instead of merely
running slowly.

## Parameters

### snapshot

[`IHeapSnapshot`](../interfaces/IHeapSnapshot.md)

the heap snapshot to write, as returned by
`getFullHeapFromFile` or [takeNodeMinimalHeap](takeNodeMinimalHeap.md)

### outputFile

`string`

absolute path of the file to create; an existing file at
that path is overwritten

## Returns

`void`

this API returns void; the snapshot is written to `outputFile`

* **Examples**:
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import {dumpNodeHeapSnapshot, serializeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const file = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getFullHeapFromFile(file);

  // ... modify the heap snapshot in memory ...

  serializeHeapSnapshot(heap, '/tmp/modified.heapsnapshot');
})();
```
