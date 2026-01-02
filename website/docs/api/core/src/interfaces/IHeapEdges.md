# Interface: IHeapEdges

Defined in: core/src/lib/Types.ts:1744

A pseudo array containing all heap graph edges (references to heap objects
in heap). A JS heap could contain millions of references, so memlab uses
a pseudo array as the collection of all the heap edges. The pseudo
array provides API to query and traverse all heap references.

 modifying this pseudo array is not recommended

* **Examples**:
```typescript
import type {IHeapSnapshot, IHeapEdges} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);

  const edges: IHeapEdges = heap.edges;
  edges.length;
  edges.get(0);
  edges.forEach((edge, i) => {
    if (stopIteration) {
      return false;
    }
  });
})();
```

## Properties

### length

> **length**: `number`

Defined in: core/src/lib/Types.ts:1749

The total number of edges in heap graph (or JS references in heap
snapshot).

## Methods

### forEach()

> **forEach**(`callback`): `void`

Defined in: core/src/lib/Types.ts:1765

Iterate over all array elements and apply the callback
to each element in ascending order of element index.

#### Parameters

##### callback

(`edge`, `index`) => `boolean` \| `void`

the callback does not need to return any value, if
the callback returns `false` when iterating on element at index `i`,
then all elements after `i` won't be iterated.

#### Returns

`void`

***

### get()

> **get**(`index`): [`Nullable`](../type-aliases/Nullable.md)\<[`IHeapEdge`](IHeapEdge.md)\>

Defined in: core/src/lib/Types.ts:1757

get an [IHeapEdge](IHeapEdge.md) element at the specified index

#### Parameters

##### index

`number`

the index of an element in the pseudo array, the index ranges
from 0 to array length - 1. Notice that this is not the heap node id.

#### Returns

[`Nullable`](../type-aliases/Nullable.md)\<[`IHeapEdge`](IHeapEdge.md)\>

When 0 <= `index` < array.length, this API returns the element
at the specified index, otherwise it returns `null`.
