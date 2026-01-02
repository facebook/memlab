# Function: takeNodeMinimalHeap()

> **takeNodeMinimalHeap**(): `Promise`\<[`IHeapSnapshot`](../interfaces/IHeapSnapshot.md)\>

Defined in: core/src/lib/NodeHeap.ts:152

Take a heap snapshot of the current program state
and parse it as [IHeapSnapshot](../interfaces/IHeapSnapshot.md). Notice that
this API does not calculate some heap analysis meta data
for heap analysis. But this also means faster heap parsing.

## Returns

`Promise`\<[`IHeapSnapshot`](../interfaces/IHeapSnapshot.md)\>

heap representation without heap analysis meta data.

* **Examples:**
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import {takeNodeMinimalHeap} from '@memlab/core';

(async function () {
  const heap: IHeapSnapshot = await takeNodeMinimalHeap();
})();
```

If you need to get the heap snapshot with heap analysis meta data, please
use getFullHeapFromFile.
