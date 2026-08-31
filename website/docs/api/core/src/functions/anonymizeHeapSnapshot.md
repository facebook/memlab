# Function: anonymizeHeapSnapshot()

> **anonymizeHeapSnapshot**(`snapshot`, `options?`): [`AnonymizeReport`](../type-aliases/AnonymizeReport.md)

Defined in: core/src/lib/HeapAnonymizer.ts:614

Rewrite a parsed heap snapshot in place so it no longer carries user data.

Redacts the content of every string on the heap, plus any string table entry
whose text looks like an identifier, a credential or serialized DOM. Class
names, function names and ordinary property keys are left alone, so retainer
traces, class histograms, dominator trees and shape analyses all still work
on the result.

The snapshot is modified in place and its parsed view updates with it — node
names are read from the string table on each access rather than cached.
Persist the result with [serializeHeapSnapshot](serializeHeapSnapshot.md).

This does not defeat a determined attacker who already knows what they are
looking for: lengths are preserved exactly (they have to be, or `self_size`
stops matching), and in `stable` mode equal values stay equal. It removes the
content, not the shape of the content.

## Parameters

### snapshot

[`IHeapSnapshot`](../interfaces/IHeapSnapshot.md)

the parsed heap snapshot to rewrite in place

### options?

[`AnonymizeOptions`](../type-aliases/AnonymizeOptions.md) = `{}`

see [AnonymizeOptions](../type-aliases/AnonymizeOptions.md)

## Returns

[`AnonymizeReport`](../type-aliases/AnonymizeReport.md)

a summary of what was redacted, per rule; see
[AnonymizeReport](../type-aliases/AnonymizeReport.md)

* **Examples**:
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import {
  dumpNodeHeapSnapshot,
  anonymizeHeapSnapshot,
  serializeHeapSnapshot,
} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const file = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getFullHeapFromFile(file);

  const report = anonymizeHeapSnapshot(heap);
  console.log(`redacted ${report.valuesRedacted} string values`);

  serializeHeapSnapshot(heap, '/tmp/shareable.heapsnapshot');
})();
```
