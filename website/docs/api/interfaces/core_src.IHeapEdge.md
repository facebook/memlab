---
id: "core_src.IHeapEdge"
title: "Interface: IHeapEdge"
sidebar_label: "IHeapEdge"
custom_edit_url: null
---

An `IHeapEdge` instance represents a JS reference in a heap snapshot.
A heap snapshot is generally a graph where graph nodes are JS heap objects
and graph edges are JS references among JS heap objects.

**`readonly`** it is not recommended to modify any `IHeapEdge` instance

* **Examples**: V8 or hermes heap snapshot can be parsed by the
[getHeapFromFile](../modules/heap_analysis_src.md#getheapfromfile) API.

```typescript
import type {IHeapSnapshot, IHeapEdge} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getHeapFromFile(heapFile);

  // iterate over each edge (JS reference in heap)
  heap.edges.forEach((edge: IHeapEdge, i: number) => {
    // use the heap edge APIs here
    const nameOrIndex = edge.name_or_index;
    // ...
  });
})();
```

## Hierarchy

- `IHeapEdgeBasic`

  ↳ **`IHeapEdge`**

## Properties

### <a id="edgeindex" name="edgeindex"></a> **edgeIndex**: `number`

index of this JS reference inside the `edge.snapshot.edges` pseudo array

 * **Source**:
    * core/src/lib/Types.ts:1192

___

### <a id="fromnode" name="fromnode"></a> **fromNode**: [`IHeapNode`](core_src.IHeapNode.md)

returns an [IHeapNode](core_src.IHeapNode.md) instance representing the hosting
JS heap object where this reference starts

 * **Source**:
    * core/src/lib/Types.ts:1213

___

### <a id="is\_index" name="is\_index"></a> **is\_index**: `boolean`

if `true`, means this is a reference to an array element
or internal table element (`edge.name_or_index` will return a number),
otherwise this is a reference with a string name (`edge.name_or_index`
will return a string)

 * **Source**:
    * core/src/lib/Types.ts:1199

___

### <a id="name\_or\_index" name="name\_or\_index"></a> **name\_or\_index**: `string` \| `number`

name of the JS reference. If this is a reference to an array element
or internal table element, it is an numeric index

 * **Source**:
    * core/src/lib/Types.ts:1148

___

### <a id="snapshot" name="snapshot"></a> **snapshot**: [`IHeapSnapshot`](core_src.IHeapSnapshot.md)

get the [IHeapSnapshot](core_src.IHeapSnapshot.md) containing this JS reference

 * **Source**:
    * core/src/lib/Types.ts:1188

___

### <a id="tonode" name="tonode"></a> **toNode**: [`IHeapNode`](core_src.IHeapNode.md)

returns an [IHeapNode](core_src.IHeapNode.md) instance representing the JS heap object
pointed to by this reference

 * **Source**:
    * core/src/lib/Types.ts:1208

___

### <a id="to\_node" name="to\_node"></a> **to\_node**: `number`

the index of the JS heap object pointed to by this reference

 * **Source**:
    * core/src/lib/Types.ts:1203

___

### <a id="type" name="type"></a> **type**: `string`

type of the JS reference, all types:
`context`, `element`, `property`, `internal`, `hidden`, `shortcut`, `weak`

 * **Source**:
    * core/src/lib/Types.ts:1153
