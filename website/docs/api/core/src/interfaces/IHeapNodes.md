# Interface: IHeapNodes

Defined in: core/src/lib/Types.ts:2258

A pseudo array containing all heap graph nodes (JS objects
in heap). A JS heap could contain millions of objects, so memlab uses
a pseudo array as the collection of all the heap nodes. The pseudo
array provides API to query and traverse all heap objects.

 modifying this pseudo array is not recommended

* **Examples**:
```typescript
import type {IHeapSnapshot, IHeapNodes} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);

  const nodes: IHeapNodes = heap.nodes;
  nodes.length;
  nodes.get(0);
  nodes.forEach((node, i) => {
    if (stopIteration) {
      return false;
    }
  });
})();
```

## Properties

### length

> **length**: `number`

Defined in: core/src/lib/Types.ts:2263

The total number of nodes in heap graph (or JS objects in heap
snapshot).

## Methods

### forEach()

> **forEach**(`callback`): `void`

Defined in: core/src/lib/Types.ts:2279

Iterates over all array elements and applies the callback
to each element in ascending order of element index.

#### Parameters

##### callback

(`node`, `index`) => `boolean` \| `void`

the callback does not need to return any value, if
the callback returns `false` when iterating on element at index `i`,
then all elements after `i` won't be iterated.

#### Returns

`void`

***

### get()

> **get**(`index`): [`Nullable`](../type-aliases/Nullable.md)\<[`IHeapNode`](IHeapNode.md)\>

Defined in: core/src/lib/Types.ts:2271

Gets an [IHeapNode](IHeapNode.md) element at the specified index.

#### Parameters

##### index

`number`

the index of an element in the pseudo array, the index ranges
from 0 to array length - 1. Notice that this is not the heap node id.

#### Returns

[`Nullable`](../type-aliases/Nullable.md)\<[`IHeapNode`](IHeapNode.md)\>

When 0 <= `index` < array.length, this API returns the element
at the specified index, otherwise it returns `null`.
