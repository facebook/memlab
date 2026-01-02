# Variable: getFullHeapFromFile()

> **getFullHeapFromFile**: (`file`) => `Promise`\<`IHeapSnapshot`\>

Defined in: heap-analysis/src/index.ts:23

Load and parse a `.heapsnapshot` file and calculate meta data like
dominator nodes and retained sizes.

## Parameters

### file

`string`

the absolute path of the `.heapsnapshot` file

## Returns

`Promise`\<`IHeapSnapshot`\>

the heap graph representation instance that supports querying
the heap
* **Examples**:
```typescript
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function (){
  const heapFile = dumpNodeHeapSnapshot();
  const heap = await getFullHeapFromFile(heapFile);
})();
```
