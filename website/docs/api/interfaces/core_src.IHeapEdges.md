---
id: "core_src.IHeapEdges"
title: "Interface: IHeapEdges"
sidebar_label: "IHeapEdges"
custom_edit_url: null
---

A pseudo array containing all heap graph edges (references to heap objects
in heap). A JS heap could contain millions of references, so memlab uses
a pseudo array as the collection of all the heap edges. The pseudo
array provides API to query and traverse all heap references.

**`readonly`** modifying this pseudo array is not recommended

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

### <a id="length" name="length"></a> **length**: `number`

The total number of edges in heap graph (or JS references in heap
snapshot).

 * **Source**:
    * core/src/lib/Types.ts:1719

## Methods

### <a id="foreach"></a>**forEach**(`callback`)

Iterate over all array elements and apply the callback
to each element in ascending order of element index.

 * **Parameters**:
    * `callback`: (`edge`: [`IHeapEdge`](core_src.IHeapEdge.md), `index`: `number`) => `boolean` \| `void` | the callback does not need to return any value, if the callback returns `false` when iterating on element at index `i`, then all elements after `i` won't be iterated.
 * **Returns**: `void`
 * **Source**:
    * core/src/lib/Types.ts:1735

___

### <a id="get"></a>**get**(`index`)

get an [IHeapEdge](core_src.IHeapEdge.md) element at the specified index

 * **Parameters**:
    * `index`: `number` | the index of an element in the pseudo array, the index ranges from 0 to array length - 1. Notice that this is not the heap node id.
 * **Returns**: [`Nullable`](../modules/core_src.md#nullable)<[`IHeapEdge`](core_src.IHeapEdge.md)\> | When 0 <= `index` < array.length, this API returns the element
at the specified index, otherwise it returns `null`.

 * **Source**:
    * core/src/lib/Types.ts:1727
