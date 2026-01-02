# Variable: takeNodeFullHeap()

> **takeNodeFullHeap**: () => `Promise`\<`IHeapSnapshot`\>

Defined in: heap-analysis/src/index.ts:28

Take a heap snapshot of the current program state
and parse it as IHeapSnapshot. This
API also calculates some heap analysis meta data
for heap analysis. But this also means slower heap parsing
comparing with takeNodeMinimalHeap.

## Returns

`Promise`\<`IHeapSnapshot`\>

heap representation with heap analysis meta data.

* **Examples:**
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import type {takeNodeFullHeap} from '@memlab/heap-analysis';

(async function () {
  const heap: IHeapSnapshot = await takeNodeFullHeap();
})();
```
