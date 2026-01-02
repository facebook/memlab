# Function: dumpNodeHeapSnapshot()

> **dumpNodeHeapSnapshot**(): `string`

Defined in: core/src/lib/NodeHeap.ts:84

Take a heap snapshot of the current program state and save it as a
`.heapsnapshot` file under a randomly generated folder inside the system's
temp folder.

**Note**: All `.heapsnapshot` files could also be loaded by Chrome DevTools.

## Returns

`string`

the absolute file path to the saved `.heapsnapshot` file.

* **Examples**:
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);
})();
```
