---
id: "core_src.IHeapNodes"
title: "Interface: IHeapNodes"
sidebar_label: "IHeapNodes"
custom_edit_url: null
---

A pseudo array containing all heap graph nodes (JS objects
in heap). A JS heap could contain millions of objects, so memlab uses
a pseudo array as the collection of all the heap nodes. The pseudo
array provides API to query and traverse all heap objects.

**`readonly`** modifying this pseudo array is not recommended

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

### <a id="length" name="length"></a> **length**: `number`

The total number of nodes in heap graph (or JS objects in heap
snapshot).

 * **Source**:
    * core/src/lib/Types.ts:1850

## Methods

### <a id="foreach"></a>**forEach**(`callback`)

Iterate over all array elements and apply the callback
to each element in ascending order of element index.

 * **Parameters**:
    * `callback`: (`node`: [`IHeapNode`](core_src.IHeapNode.md), `index`: `number`) => `boolean` \| `void` | the callback does not need to return any value, if the callback returns `false` when iterating on element at index `i`, then all elements after `i` won't be iterated.
 * **Returns**: `void`
 * **Source**:
    * core/src/lib/Types.ts:1866

___

### <a id="get"></a>**get**(`index`)

get an [IHeapNode](core_src.IHeapNode.md) element at the specified index

 * **Parameters**:
    * `index`: `number` | the index of an element in the pseudo array, the index ranges from 0 to array length - 1. Notice that this is not the heap node id.
 * **Returns**: `Nullable`<[`IHeapNode`](core_src.IHeapNode.md)\> | When 0 <= `index` < array.length, this API returns the element
at the specified index, otherwise it returns `null`.

 * **Source**:
    * core/src/lib/Types.ts:1858
